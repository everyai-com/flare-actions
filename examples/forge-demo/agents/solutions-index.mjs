// Every reference solution in one map, for bundlers (apps/sim demo
// loop runs them inside a Worker, where imports by computed path are
// unavailable). Keep in sync with solutions/*.mjs.
import g1_error_codes from "./solutions/g1-error-codes.mjs";
import g1_health_version from "./solutions/g1-health-version.mjs";
import g1_metrics from "./solutions/g1-metrics.mjs";
import g1_request_id from "./solutions/g1-request-id.mjs";
import g2_author_books from "./solutions/g2-author-books.mjs";
import g2_default_page_size from "./solutions/g2-default-page-size.mjs";
import g2_fuzzy_search from "./solutions/g2-fuzzy-search.mjs";
import g2_isbn_validation from "./solutions/g2-isbn-validation.mjs";
import g3_api_key_rotation from "./solutions/g3-api-key-rotation.mjs";
import g3_cors_allowlist from "./solutions/g3-cors-allowlist.mjs";
import g3_log_latency from "./solutions/g3-log-latency.mjs";
import g3_max_page_size from "./solutions/g3-max-page-size.mjs";
import g3_rate_limit from "./solutions/g3-rate-limit.mjs";

export const SOLUTIONS = {
  "g1-error-codes": g1_error_codes,
  "g1-health-version": g1_health_version,
  "g1-metrics": g1_metrics,
  "g1-request-id": g1_request_id,
  "g2-author-books": g2_author_books,
  "g2-default-page-size": g2_default_page_size,
  "g2-fuzzy-search": g2_fuzzy_search,
  "g2-isbn-validation": g2_isbn_validation,
  "g3-api-key-rotation": g3_api_key_rotation,
  "g3-cors-allowlist": g3_cors_allowlist,
  "g3-log-latency": g3_log_latency,
  "g3-max-page-size": g3_max_page_size,
  "g3-rate-limit": g3_rate_limit,
};
