import { test } from "node:test";
import assert from "node:assert/strict";
import { presidioLabel } from "./presidio.ts";

test("Presidio types map to built-in labels; dates only after birth words", () => {
  assert.equal(presidioLabel("IBAN_CODE", "", 0), "FINANCIAL");
  assert.equal(presidioLabel("US_SSN", "", 0), "NATIONAL_ID");
  assert.equal(presidioLabel("UK_NHS", "", 0), "NATIONAL_ID");
  assert.equal(presidioLabel("PERSON", "", 0), null);
  const text = "Born on 12/03/1980, joined on 01/02/2020.";
  assert.equal(presidioLabel("DATE_TIME", text, 8), "DATE_OF_BIRTH");
  assert.equal(presidioLabel("DATE_TIME", text, 30), null);
});
