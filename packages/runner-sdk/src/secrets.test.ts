import { describe, expect, it } from "vitest";
import { hasSecretPlaceholders, interpolateSecrets, maskSecrets } from "./secrets.ts";

describe("interpolateSecrets", () => {
  it("replaces secret placeholders", () => {
    expect(interpolateSecrets("echo ${{ secrets.TOKEN }}!", { TOKEN: "abc" })).toBe("echo abc!");
  });

  it("tolerates whitespace inside the expression", () => {
    expect(interpolateSecrets("${{secrets.A}}${{  secrets.B  }}", { A: "1", B: "2" })).toBe("12");
  });

  it("renders missing secrets empty", () => {
    expect(interpolateSecrets("x${{ secrets.NOPE }}y", {})).toBe("xy");
  });

  it("leaves other expressions untouched", () => {
    expect(interpolateSecrets("${{ matrix.x }} ${{ env.Y }} $HOME", { A: "1" })).toBe(
      "${{ matrix.x }} ${{ env.Y }} $HOME",
    );
  });
});

describe("maskSecrets", () => {
  it("redacts values everywhere", () => {
    expect(maskSecrets("token abc then abc again", { T: "abc" })).toBe("token *** then *** again");
  });

  it("masks longest values first", () => {
    expect(maskSecrets("abcdef", { A: "abc", B: "abcdef" })).toBe("***");
  });

  it("ignores empty values", () => {
    expect(maskSecrets("hello", { E: "" })).toBe("hello");
  });
});

describe("hasSecretPlaceholders", () => {
  it("detects leftover placeholders", () => {
    expect(hasSecretPlaceholders("run ${{ secrets.X }}")).toBe(true);
    expect(hasSecretPlaceholders("plain text")).toBe(false);
  });
});
