import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCopyBank,
  buildPublishQueue,
  normalizeBoardName,
  selectEligiblePins,
  selectNextDueJob,
  shouldStopForPinterestResponse,
} from "../scripts/pinterest_scheduler_lib.mjs";

const products = [
  { handle: "margot-bag", title: "Margot Bag", onlineStoreUrl: "https://bynyla.com/products/margot-bag" },
  { handle: "eden-bag", title: "Eden Bag", onlineStoreUrl: "https://bynyla.com/products/eden-bag" },
];

const results = [
  {
    pin: { id: "1", title: "Angel Bag", suggestedProductHandle: "margot-bag", videoUrl: "https://example.com/1.mp4" },
    vertex: { text_language: "english", has_logo: true },
  },
  {
    pin: { id: "2", title: "Bogota Bag", suggestedProductHandle: "eden-bag", videoUrl: "https://example.com/2.mp4" },
    vertex: { text_language: "english", has_logo: false },
  },
  {
    pin: { id: "3", title: "Bogota Bag", suggestedProductHandle: "eden-bag", videoUrl: "https://example.com/3.mp4" },
    vertex: { text_language: "not_english", has_logo: false },
  },
];

test("selectEligiblePins keeps all English pre-mapped pins by default", () => {
  const eligible = selectEligiblePins(results, products);
  assert.equal(eligible.length, 2);
  assert.deepEqual(eligible.map((row) => row.pinId), ["1", "2"]);
});

test("selectEligiblePins can exclude logo rows", () => {
  const eligible = selectEligiblePins(results, products, { includeLogo: false });
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].pinId, "2");
});

test("buildPublishQueue schedules no more than the daily cap and rotates products", () => {
  const manyRows = Array.from({ length: 40 }, (_, index) => ({
    ...results[index % 2],
    pin: {
      ...results[index % 2].pin,
      id: String(index + 1),
      suggestedProductHandle: index % 2 ? "eden-bag" : "margot-bag",
    },
  }));
  const eligible = selectEligiblePins(manyRows, products);
  const queue = buildPublishQueue(eligible, {
    startDate: "2026-06-27",
    dailyCap: 35,
    timezone: "Europe/Paris",
  });

  assert.equal(queue.length, 40);
  assert.equal(queue.filter((job) => job.publishDate === "2026-06-27").length, 35);
  assert.equal(queue.filter((job) => job.publishDate === "2026-06-28").length, 5);
  assert.notEqual(queue[0].productHandle, queue[1].productHandle);
});

test("copy bank titles stay under 25 visible characters", () => {
  const copy = buildCopyBank();
  assert.ok(copy.titles.length >= 20);
  for (const title of copy.titles) {
    assert.ok([...title].length <= 25, title);
  }
});

test("normalizeBoardName ignores spacing, case and punctuation", () => {
  assert.equal(normalizeBoardName("Eden Bag"), normalizeBoardName("edenbag"));
  assert.equal(normalizeBoardName("Margot - Bag!"), normalizeBoardName("margot bag"));
});

test("selectNextDueJob returns only queued due jobs", () => {
  const queue = [
    { id: "done", status: "published", scheduledAt: "2026-06-27T08:00:00" },
    { id: "future", status: "queued", scheduledAt: "2026-06-27T09:00:00" },
    { id: "due", status: "queued", scheduledAt: "2026-06-27T08:15:00" },
  ];
  assert.equal(selectNextDueJob(queue, new Date("2026-06-27T06:30:00Z"), "Europe/Paris")?.id, "due");
});

test("shouldStopForPinterestResponse catches risky publishing responses", () => {
  assert.equal(shouldStopForPinterestResponse({ status: 429, body: "too many requests" }), true);
  assert.equal(shouldStopForPinterestResponse({ status: 400, body: "spam block" }), true);
  assert.equal(shouldStopForPinterestResponse({ status: 201, body: "{}" }), false);
});
