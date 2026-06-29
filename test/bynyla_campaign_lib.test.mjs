import assert from "node:assert/strict";
import { test } from "node:test";
import { rankPinsByAtc } from "../scripts/bynyla_campaign_lib.mjs";

test("rankPinsByAtc sums click and view add-to-cart by pin", () => {
  const ads = [
    { id: "a1", pin_id: "p1" },
    { id: "a2", pin_id: "p1" },
    { id: "a3", pin_id: "p2" },
  ];
  const analytics = [
    { AD_ID: "a1", TOTAL_CLICK_ADD_TO_CART: 2, TOTAL_VIEW_ADD_TO_CART: 3 },
    { AD_ID: "a2", TOTAL_CLICK_ADD_TO_CART: 1, TOTAL_VIEW_ADD_TO_CART: 0 },
    { AD_ID: "a3", TOTAL_CLICK_ADD_TO_CART: 5, TOTAL_VIEW_ADD_TO_CART: 5 },
  ];
  const ranked = rankPinsByAtc(ads, analytics);
  assert.deepEqual(ranked.map((row) => [row.pinId, row.atc]), [["p2", 10], ["p1", 6]]);
});

test("rankPinsByAtc keeps exact ad pin id over rounded analytics pin id", () => {
  const ads = [{ id: "a1", pin_id: "1152710467152616975" }];
  const analytics = [{ AD_ID: "a1", PIN_ID: 1152710467152617000, TOTAL_CLICK_ADD_TO_CART: 1 }];

  assert.equal(rankPinsByAtc(ads, analytics)[0].pinId, "1152710467152616975");
});
