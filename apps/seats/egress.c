// Per-domain egress attribution for seat containers (glibc/Linux).
//
// LD_PRELOAD this into step processes: it observes connect/send/recv
// plus DNS — getaddrinfo for classic resolvers, port-53 wire parsing
// for c-ares runtimes like Node that never call getaddrinfo — and
// appends tally lines to $FLARE_EGRESS_LOG:
//
//   DNS <ip> <hostname>
//   OUT <ip> <bytes-sent>
//   IN  <ip> <bytes-received>
//
// Passive by default: every hook calls the real function first and
// traffic flows exactly as without the shim. Without FLARE_EGRESS_LOG
// set (or when the log cannot be opened) each hook is one flag check
// plus the real call. Byte hooks cover send/recv, read/write, and
// readv/writev (libuv drives sockets with readv/writev); counting
// is gated on a prior connect(), so pipes and accepted sockets are
// never counted.
//
// Enforcement (opt-in): with FLARE_EGRESS_ALLOW set to a comma list
// of domains, connect() to anything else fails with EACCES (and a
// BLOCK line is logged). Exact names and subdomains pass, loopback
// and DNS always pass, unknown IPs fail closed. Connectionless UDP
// (sendto without connect) is unattributed and unenforced.
// Limits, by design: outbound TCP/UDP only, dynamically linked
// binaries only (static Go/Rust bypass it — the seat treats the log
// as a lower bound and keeps the NIC-delta row as the cross-check
// total), and single-iovec datagrams for DNS parsing.
//
// Build: gcc -O2 -shared -fPIC -o egress.so egress.c -ldl
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <unistd.h>

#define MAXFD 1024
#define MAXDNS 2048
#define MAXALLOW 32
#define MAXDOMAIN 254
// Per-direction bytes held per fd before a flush line is written; the
// remainder flushes on close. A SIGKILLed step loses at most this
// much attribution per fd — bounded, and crashes stay loud (the
// shim never touches exit paths).
#define FLUSH_AT (1u << 20)
// Recent (txid -> qname) pairs per fd, so multiplexed DNS sockets
// (c-ares pipelines queries) attribute responses to the right name.
#define PENDING_PER_FD 8

static int g_logfd = -2; // -2 uninitialized, -1 disabled
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static pid_t g_pid = 0; // owning pid; fork children must not flush

static int is_dns_peer(const struct sockaddr *addr, socklen_t len);

static struct {
  char ip[64]; // peer from connect(); empty = untracked
  uint16_t peer_port; // peer port, so connected-UDP DNS (NULL addr
  // on sendto, as c-ares uses) still snoops queries
  long out;
  long in;
  struct {
    uint16_t txid;
    char name[256];
  } pending[PENDING_PER_FD];
  int pending_next;
} g_fd[MAXFD];

static struct {
  char ip[64];
  char name[256];
} g_dns[MAXDNS];
static int g_dns_next = 0;

// Enforcement allowlist, parsed once from FLARE_EGRESS_ALLOW.
// allow_init: 0 unparsed, 1 parsed. Empty/unset = observe-only.
static char g_allow[MAXALLOW][MAXDOMAIN];
static int g_allow_n = 0;
static int g_allow_init = 0;

static int log_ready(void) {
  if (g_logfd != -2) return g_logfd;
  const char *path = getenv("FLARE_EGRESS_LOG");
  if (!path || !*path) {
    g_logfd = -1;
    return -1;
  }
  g_logfd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0644);
  if (g_logfd < 0) g_logfd = -1;
  return g_logfd;
}

static void emit(const char *line, size_t len) {
  int fd = log_ready();
  if (fd < 0) return;
  size_t off = 0;
  while (off < len) {
    ssize_t w = write(fd, line + off, len - off);
    if (w <= 0) return;
    off += (size_t)w;
  }
}

static void copy_name(char *dst, size_t size, const char *src) {
  if (size == 0) return;
  size_t i = 0;
  while (i + 1 < size && src[i]) {
    dst[i] = src[i];
    i++;
  }
  dst[i] = '\0';
}

static void allow_init(void) {
  if (g_allow_init) return;
  g_allow_init = 1;
  const char *env = getenv("FLARE_EGRESS_ALLOW");
  if (!env || !*env) return;
  char buf[4096];
  copy_name(buf, sizeof buf, env);
  char *save = NULL;
  for (char *tok = strtok_r(buf, ",", &save); tok && g_allow_n < MAXALLOW; tok = strtok_r(NULL, ",", &save)) {
    while (*tok == ' ' || *tok == '\t') tok++;
    size_t len = strlen(tok);
    while (len > 0 && (tok[len - 1] == ' ' || tok[len - 1] == '\t')) tok[--len] = '\0';
    if (len == 0 || len >= MAXDOMAIN) continue;
    for (size_t i = 0; i < len; i++) {
      if (tok[i] >= 'A' && tok[i] <= 'Z') tok[i] += 32;
    }
    strcpy(g_allow[g_allow_n++], tok);
  }
}

// Exact or subdomain match (host == allow, or host ends .allow).
static int allow_match(const char *host, const char *allow) {
  size_t hlen = strlen(host);
  size_t alen = strlen(allow);
  if (hlen < alen) return 0;
  if (strcmp(host + hlen - alen, allow) != 0) return 0;
  return hlen == alen || host[hlen - alen - 1] == '.';
}

static int is_loopback_ip(const char *ip) {
  if (strncmp(ip, "127.", 4) == 0) return 1;
  return strcmp(ip, "::1") == 0;
}

// Most recent hostname mapped to ip (getaddrinfo + wire snoops
// both feed g_dns). Returns 1 on hit, copying lowercased.
static int dns_name_for(const char *ip, char *out, size_t outlen) {
  int found = 0;
  pthread_mutex_lock(&g_lock);
  for (int i = 0; i < MAXDNS; i++) {
    int idx = (g_dns_next + MAXDNS - 1 - i) % MAXDNS;
    if (g_dns[idx].ip[0] && strcmp(g_dns[idx].ip, ip) == 0 && g_dns[idx].name[0]) {
      copy_name(out, outlen, g_dns[idx].name);
      found = 1;
      break;
    }
  }
  pthread_mutex_unlock(&g_lock);
  if (found) {
    for (size_t i = 0; out[i]; i++) {
      if (out[i] >= 'A' && out[i] <= 'Z') out[i] += 32;
    }
  }
  return found;
}

// 1 = connect() may proceed. Observe-only when no allowlist is set.
static int egress_allowed(const char *ip) {
  allow_init();
  if (g_allow_n == 0) return 1;
  if (is_loopback_ip(ip)) return 1;
  char host[256];
  if (!dns_name_for(ip, host, sizeof host)) return 0;
  for (int i = 0; i < g_allow_n; i++) {
    if (allow_match(host, g_allow[i])) return 1;
  }
  return 0;
}

static int looks_numeric(const char *s) {
  if (!s || !*s) return 1;
  // Skip numeric getaddrinfo nodes: recording "1.2.3.4" as a hostname
  // would split rows the seat parser would rather see as ip:1.2.3.4.
  return (*s >= '0' && *s <= '9') || *s == ':' || *s == '[';
}

static void dns_add(const char *ip, const char *name) {
  if (!ip || !*ip || !name || !*name || looks_numeric(name)) return;
  char line[384];
  int n = snprintf(line, sizeof line, "DNS %s %s\n", ip, name);
  if (n <= 0 || (size_t)n >= sizeof line) return;
  pthread_mutex_lock(&g_lock);
  // De-dupe consecutive repeats only; the seat aggregates the rest.
  int prev = (g_dns_next + MAXDNS - 1) % MAXDNS;
  if (!(g_dns[prev].ip[0] && strcmp(g_dns[prev].ip, ip) == 0 && strcmp(g_dns[prev].name, name) == 0)) {
    copy_name(g_dns[g_dns_next].ip, sizeof g_dns[g_dns_next].ip, ip);
    copy_name(g_dns[g_dns_next].name, sizeof g_dns[g_dns_next].name, name);
    g_dns_next = (g_dns_next + 1) % MAXDNS;
    pthread_mutex_unlock(&g_lock);
    emit(line, (size_t)n);
    return;
  }
  pthread_mutex_unlock(&g_lock);
}

static void count(int fd, long out_delta, long in_delta) {
  if (fd < 0 || fd >= MAXFD || fd == g_logfd) return;
  if (g_logfd == -1) return;
  pthread_mutex_lock(&g_lock);
  if (!g_fd[fd].ip[0]) {
    pthread_mutex_unlock(&g_lock);
    return;
  }
  g_fd[fd].out += out_delta;
  g_fd[fd].in += in_delta;
  char ip[64];
  strcpy(ip, g_fd[fd].ip);
  long out = g_fd[fd].out;
  long in = g_fd[fd].in;
  if (out >= FLUSH_AT) g_fd[fd].out = 0;
  if (in >= FLUSH_AT) g_fd[fd].in = 0;
  pthread_mutex_unlock(&g_lock);
  char line[128];
  if (out >= FLUSH_AT) {
    int n = snprintf(line, sizeof line, "OUT %s %ld\n", ip, out);
    if (n > 0 && (size_t)n < sizeof line) emit(line, (size_t)n);
  }
  if (in >= FLUSH_AT) {
    int n = snprintf(line, sizeof line, "IN %s %ld\n", ip, in);
    if (n > 0 && (size_t)n < sizeof line) emit(line, (size_t)n);
  }
}

static void flush_fd_locked(int fd) {
  char ip[64];
  strcpy(ip, g_fd[fd].ip);
  long out = g_fd[fd].out;
  long in = g_fd[fd].in;
  memset(&g_fd[fd], 0, sizeof g_fd[fd]);
  pthread_mutex_unlock(&g_lock);
  if (!ip[0] || g_logfd == -1) return;
  char line[128];
  if (out > 0) {
    int n = snprintf(line, sizeof line, "OUT %s %ld\n", ip, out);
    if (n > 0 && (size_t)n < sizeof line) emit(line, (size_t)n);
  }
  if (in > 0) {
    int n = snprintf(line, sizeof line, "IN %s %ld\n", ip, in);
    if (n > 0 && (size_t)n < sizeof line) emit(line, (size_t)n);
  }
}

static void flush_fd(int fd) {
  if (fd < 0 || fd >= MAXFD || fd == g_logfd) return;
  pthread_mutex_lock(&g_lock);
  flush_fd_locked(fd);
}

// Destructor-time flush: trylock only, so an exit racing live IO
// can never deadlock — a skipped fd loses at most FLUSH_AT bytes.
static void flush_fd_try(int fd) {
  if (fd < 0 || fd >= MAXFD || fd == g_logfd) return;
  if (pthread_mutex_trylock(&g_lock) != 0) return;
  flush_fd_locked(fd);
}

static void note_pid(void) {
  if (!g_pid) g_pid = getpid();
}

// Processes that exit with sockets still open (Node drains the loop
// and exits without close()) would lose every sub-FLUSH_AT flow to
// the close hook alone — flush everything at normal exit. Fork
// children share the tables until exec, so only the owning pid
// flushes; _exit/exec/SIGKILL paths keep the bounded loss.
__attribute__((destructor)) static void egress_on_exit(void) {
  if (g_pid == 0 || getpid() != g_pid) return;
  for (int fd = 0; fd < MAXFD; fd++) flush_fd_try(fd);
}

// A fork child inherits live counters; if it closed the shared fd it
// would emit the parent's partial bytes and the parent would emit
// them again — silent over-counting. Drop the child's copy instead:
// the parent's close/exit still reports its share, and anything the
// child adds afterwards is genuinely new (under-count beats
// over-count for accounting). DNS mappings survive: still valid,
// and re-emitting them would only duplicate lines the seat dedupes.
static void egress_after_fork_child(void) {
  memset(g_fd, 0, sizeof g_fd);
  g_pid = 0;
}

__attribute__((constructor)) static void egress_on_load(void) {
  pthread_atfork(NULL, NULL, egress_after_fork_child);
}

static void track_connect(int fd, const struct sockaddr *addr, socklen_t len) {
  if (!addr || fd < 0 || fd >= MAXFD || fd == g_logfd) return;
  if (g_logfd == -1) return;
  // Resolver traffic is snooped for name mappings (see snoop_*)
  // but never counted: a row of DNS bytes against the resolver IP
  // would be noise in every job's egress, and the NIC row still
  // includes it in the total. The port is still recorded so
  // connected-UDP queries (NULL addr on sendto) snoop correctly;
  // count() skips the fd because no IP is recorded.
  if (is_dns_peer(addr, len)) {
    pthread_mutex_lock(&g_lock);
    g_fd[fd].peer_port = 53;
    pthread_mutex_unlock(&g_lock);
    return;
  }
  char ip[64] = "";
  uint16_t port = 0;
  if (addr->sa_family == AF_INET) {
    const struct sockaddr_in *a = (const struct sockaddr_in *)addr;
    if (!inet_ntop(AF_INET, &a->sin_addr, ip, sizeof ip)) return;
    port = ntohs(a->sin_port);
  } else if (addr->sa_family == AF_INET6) {
    const struct sockaddr_in6 *a = (const struct sockaddr_in6 *)addr;
    if (!inet_ntop(AF_INET6, &a->sin6_addr, ip, sizeof ip)) return;
    port = ntohs(a->sin6_port);
  } else {
    return;
  }
  pthread_mutex_lock(&g_lock);
  strcpy(g_fd[fd].ip, ip);
  g_fd[fd].peer_port = port;
  pthread_mutex_unlock(&g_lock);
  note_pid();
}

// --- DNS wire parsing (UDP/TCP port 53, single datagram) ---

// Reads a possibly-compressed name at *off into out; returns the
// offset after the name, or -1 on malformed/truncated input.
static long dns_name(const uint8_t *msg, long len, long off, char *out, size_t outlen) {
  size_t pos = 0;
  int jumps = 0;
  long after = -1;
  while (off < len) {
    uint8_t b = msg[off];
    if (b == 0) {
      off += 1;
      break;
    }
    if ((b & 0xC0) == 0xC0) {
      if (off + 1 >= len) return -1;
      if (after < 0) after = off + 2;
      off = ((b & 0x3F) << 8) | msg[off + 1];
      if (++jumps > 8 || off < 0 || off >= len) return -1;
      continue;
    }
    if (b & 0xC0) return -1;
    if (off + 1 + b > len) return -1;
    if (pos > 0) {
      if (pos + 1 >= outlen) return -1;
      out[pos++] = '.';
    }
    if (pos + b >= outlen) return -1;
    for (int i = 0; i < b; i++) {
      uint8_t c = msg[off + 1 + i];
      // Hostnames only; anything exotic fails closed (no mapping).
      if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_')) return -1;
      out[pos++] = (char)(c >= 'A' && c <= 'Z' ? c + 32 : c);
    }
    off += 1 + b;
  }
  if (pos == 0 || pos >= outlen) return -1;
  out[pos] = '\0';
  return after >= 0 ? after : off;
}

static void pending_add(int fd, uint16_t txid, const char *name) {
  if (fd < 0 || fd >= MAXFD) return;
  pthread_mutex_lock(&g_lock);
  int slot = g_fd[fd].pending_next % PENDING_PER_FD;
  g_fd[fd].pending[slot].txid = txid;
  copy_name(g_fd[fd].pending[slot].name, sizeof g_fd[fd].pending[slot].name, name);
  g_fd[fd].pending_next++;
  pthread_mutex_unlock(&g_lock);
}

static void pending_lookup(int fd, uint16_t txid, char *out, size_t outlen) {
  out[0] = '\0';
  if (fd < 0 || fd >= MAXFD) return;
  pthread_mutex_lock(&g_lock);
  for (int i = 0; i < PENDING_PER_FD; i++) {
    if (g_fd[fd].pending[i].name[0] && g_fd[fd].pending[i].txid == txid) {
      copy_name(out, outlen, g_fd[fd].pending[i].name);
      break;
    }
  }
  pthread_mutex_unlock(&g_lock);
}

// First question's qname from a query datagram; "" when unparseable.
static void dns_query_name(const uint8_t *msg, long len, char *out, size_t outlen) {
  out[0] = '\0';
  if (len < 12) return;
  if ((msg[2] & 0x80) != 0) return; // not a query
  int qd = (msg[4] << 8) | msg[5];
  if (qd < 1) return;
  char name[256];
  if (dns_name(msg, len, 12, name, sizeof name) < 0) return;
  copy_name(out, outlen, name);
}

// Attribute every A/AAAA answer to the pending qname for this txid.
static void dns_response_addrs(int fd, const uint8_t *msg, long len) {
  if (len < 12 || (msg[2] & 0x80) == 0) return; // not a response
  if ((msg[3] & 0x0F) != 0) return; // rcode != NOERROR
  uint16_t txid = ((uint16_t)msg[0] << 8) | msg[1];
  char qname[256];
  pending_lookup(fd, txid, qname, sizeof qname);
  if (!qname[0]) return;
  int qd = (msg[4] << 8) | msg[5];
  int an = (msg[6] << 8) | msg[7];
  if (an < 1 || an > 64) return;
  long off = 12;
  char skip[256];
  for (int i = 0; i < qd && i < 8; i++) {
    off = dns_name(msg, len, off, skip, sizeof skip);
    if (off < 0 || off + 4 > len) return;
    off += 4; // qtype + qclass
  }
  for (int i = 0; i < an; i++) {
    off = dns_name(msg, len, off, skip, sizeof skip);
    if (off < 0 || off + 10 > len) return;
    uint16_t type = ((uint16_t)msg[off] << 8) | msg[off + 1];
    uint16_t rdlen = ((uint16_t)msg[off + 8] << 8) | msg[off + 9];
    off += 10;
    if (off + rdlen > len) return;
    char ip[64] = "";
    if (type == 1 && rdlen == 4) {
      inet_ntop(AF_INET, msg + off, ip, sizeof ip);
    } else if (type == 28 && rdlen == 16) {
      inet_ntop(AF_INET6, msg + off, ip, sizeof ip);
    }
    if (ip[0]) dns_add(ip, qname);
    off += rdlen;
  }
}

static int is_dns_peer(const struct sockaddr *addr, socklen_t len) {
  if (!addr || len == 0) return 0;
  if (addr->sa_family == AF_INET && len >= (socklen_t)sizeof(struct sockaddr_in)) {
    return ((const struct sockaddr_in *)addr)->sin_port == htons(53);
  }
  if (addr->sa_family == AF_INET6 && len >= (socklen_t)sizeof(struct sockaddr_in6)) {
    return ((const struct sockaddr_in6 *)addr)->sin6_port == htons(53);
  }
  return 0;
}

// Connected sockets pass NULL addrs to send/recv/sendto; the
// connect-time peer port covers those (c-ares and Python both use
// connected UDP for DNS).
static int snoop_peer_is_dns(int fd, const struct sockaddr *addr, socklen_t len) {
  if (is_dns_peer(addr, len)) return 1;
  if (addr != NULL || fd < 0 || fd >= MAXFD) return 0;
  pthread_mutex_lock(&g_lock);
  int dns = g_fd[fd].peer_port == 53;
  pthread_mutex_unlock(&g_lock);
  return dns;
}

static void snoop_send(int fd, const void *buf, size_t n, const struct sockaddr *addr, socklen_t len) {
  if (g_logfd == -1 || !buf || n < 12 || n > 4096) return;
  if (!snoop_peer_is_dns(fd, addr, len)) return;
  const uint8_t *msg = (const uint8_t *)buf;
  char name[256];
  dns_query_name(msg, (long)n, name, sizeof name);
  if (name[0]) pending_add(fd, ((uint16_t)msg[0] << 8) | msg[1], name);
}

static void snoop_recv(int fd, const void *buf, ssize_t n, const struct sockaddr *addr, socklen_t len) {
  if (g_logfd == -1 || !buf || n < 12 || n > 4096) return;
  if (!snoop_peer_is_dns(fd, addr, len)) return;
  dns_response_addrs(fd, (const uint8_t *)buf, (long)n);
}

// --- interposed functions ---

#define RESOLVE(ret, name, ...)                        \
  static ret (*real_##name)(__VA_ARGS__) = NULL;       \
  if (!real_##name) {                                  \
    real_##name = dlsym(RTLD_NEXT, #name);             \
    if (!real_##name) abort();                         \
  }

int connect(int fd, const struct sockaddr *addr, socklen_t len) {
  RESOLVE(int, connect, int, const struct sockaddr *, socklen_t);
  // Enforcement first (DNS peers never block: resolution must work
  // for the allowed names to resolve at all).
  if (addr && (addr->sa_family == AF_INET || addr->sa_family == AF_INET6) && !is_dns_peer(addr, len)) {
    char ip[64] = "";
    if (addr->sa_family == AF_INET) {
      inet_ntop(AF_INET, &((const struct sockaddr_in *)addr)->sin_addr, ip, sizeof ip);
    } else {
      inet_ntop(AF_INET6, &((const struct sockaddr_in6 *)addr)->sin6_addr, ip, sizeof ip);
    }
    if (ip[0] && !egress_allowed(ip)) {
      char host[256] = "?";
      dns_name_for(ip, host, sizeof host);
      char line[384];
      int n = snprintf(line, sizeof line, "BLOCK %s %s\n", ip, host[0] ? host : "?");
      if (n > 0 && (size_t)n < sizeof line) emit(line, (size_t)n);
      errno = EACCES;
      return -1;
    }
  }
  // Record before the real call: non-blocking connects (Node)
  // return EINPROGRESS and complete later; bytes only flow after
  // success, and close() flushes nothing for unconnected fds.
  track_connect(fd, addr, len);
  return real_connect(fd, addr, len);
}

int close(int fd) {
  RESOLVE(int, close, int);
  int rc = real_close(fd);
  flush_fd(fd);
  return rc;
}

ssize_t read(int fd, void *buf, size_t n) {
  RESOLVE(ssize_t, read, int, void *, size_t);
  ssize_t rc = real_read(fd, buf, n);
  if (rc > 0) count(fd, 0, rc);
  return rc;
}

ssize_t write(int fd, const void *buf, size_t n) {
  RESOLVE(ssize_t, write, int, const void *, size_t);
  ssize_t rc = real_write(fd, buf, n);
  if (rc > 0) count(fd, rc, 0);
  return rc;
}

ssize_t readv(int fd, const struct iovec *iov, int n) {
  RESOLVE(ssize_t, readv, int, const struct iovec *, int);
  ssize_t rc = real_readv(fd, iov, n);
  if (rc > 0) count(fd, 0, rc);
  return rc;
}

ssize_t writev(int fd, const struct iovec *iov, int n) {
  RESOLVE(ssize_t, writev, int, const struct iovec *, int);
  ssize_t rc = real_writev(fd, iov, n);
  if (rc > 0) count(fd, rc, 0);
  return rc;
}

ssize_t send(int fd, const void *buf, size_t n, int flags) {
  RESOLVE(ssize_t, send, int, const void *, size_t, int);
  ssize_t rc = real_send(fd, buf, n, flags);
  if (rc > 0) {
    count(fd, rc, 0);
    snoop_send(fd, buf, (size_t)rc, NULL, 0);
  }
  return rc;
}

ssize_t recv(int fd, void *buf, size_t n, int flags) {
  RESOLVE(ssize_t, recv, int, void *, size_t, int);
  ssize_t rc = real_recv(fd, buf, n, flags);
  if (rc > 0) {
    count(fd, 0, rc);
    snoop_recv(fd, buf, rc, NULL, 0);
  }
  return rc;
}

ssize_t sendto(int fd, const void *buf, size_t n, int flags, const struct sockaddr *addr, socklen_t len) {
  RESOLVE(ssize_t, sendto, int, const void *, size_t, int, const struct sockaddr *, socklen_t);
  ssize_t rc = real_sendto(fd, buf, n, flags, addr, len);
  if (rc > 0) {
    count(fd, rc, 0);
    snoop_send(fd, buf, (size_t)rc, addr, len);
  }
  return rc;
}

ssize_t recvfrom(int fd, void *buf, size_t n, int flags, struct sockaddr *addr, socklen_t *len) {
  RESOLVE(ssize_t, recvfrom, int, void *, size_t, int, struct sockaddr *, socklen_t *);
  socklen_t before = (addr && len) ? *len : 0;
  ssize_t rc = real_recvfrom(fd, buf, n, flags, addr, len);
  if (rc > 0) {
    count(fd, 0, rc);
    if (addr && len) snoop_recv(fd, buf, rc, addr, before);
  }
  return rc;
}

ssize_t sendmsg(int fd, const struct msghdr *msg, int flags) {
  RESOLVE(ssize_t, sendmsg, int, const struct msghdr *, int);
  ssize_t rc = real_sendmsg(fd, msg, flags);
  if (rc > 0) {
    count(fd, rc, 0);
    if (msg && msg->msg_iovlen > 0 && msg->msg_iov) snoop_send(fd, msg->msg_iov[0].iov_base, msg->msg_iov[0].iov_len, msg->msg_name, msg->msg_namelen);
  }
  return rc;
}

ssize_t recvmsg(int fd, struct msghdr *msg, int flags) {
  RESOLVE(ssize_t, recvmsg, int, struct msghdr *, int);
  socklen_t before = (msg && msg->msg_name) ? msg->msg_namelen : 0;
  ssize_t rc = real_recvmsg(fd, msg, flags);
  if (rc > 0) {
    count(fd, 0, rc);
    if (msg && msg->msg_iovlen > 0 && msg->msg_iov && msg->msg_name) {
      // Gather the datagram (DNS fits; anything larger fails the
      // size check in snoop_recv and stays unattributed).
      size_t got = 0;
      static __thread char gather[4096];
      for (size_t i = 0; i < msg->msg_iovlen && got < sizeof gather && got < (size_t)rc; i++) {
        size_t take = msg->msg_iov[i].iov_len;
        if (take > sizeof gather - got) take = sizeof gather - got;
        if (take > (size_t)rc - got) take = (size_t)rc - got;
        memcpy(gather + got, msg->msg_iov[i].iov_base, take);
        got += take;
      }
      snoop_recv(fd, gather, (ssize_t)got, msg->msg_name, before);
    }
  }
  return rc;
}

int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **res) {
  RESOLVE(int, getaddrinfo, const char *, const char *, const struct addrinfo *, struct addrinfo **);
  int rc = real_getaddrinfo(node, service, hints, res);
  if (rc == 0 && node && *node && !looks_numeric(node) && g_logfd != -1 && res && *res) {
    for (struct addrinfo *ai = *res; ai; ai = ai->ai_next) {
      char ip[64] = "";
      if (ai->ai_family == AF_INET) {
        inet_ntop(AF_INET, &((struct sockaddr_in *)ai->ai_addr)->sin_addr, ip, sizeof ip);
      } else if (ai->ai_family == AF_INET6) {
        inet_ntop(AF_INET6, &((struct sockaddr_in6 *)ai->ai_addr)->sin6_addr, ip, sizeof ip);
      }
      if (ip[0]) dns_add(ip, node);
    }
  }
  return rc;
}
