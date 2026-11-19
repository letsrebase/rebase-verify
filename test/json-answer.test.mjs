import test from "node:test";
import assert from "node:assert/strict";
import { firstJsonObject, NoJsonError } from "../src/agents/json-answer.mjs";

test("plain object", () => assert.deepEqual(firstJsonObject('{"a":1}'), { a: 1 }));
test("fenced", () => assert.deepEqual(firstJsonObject('```json\n{"a":{"b":2}}\n```'), { a: { b: 2 } }));
test("trailing chatter with braces", () =>
  assert.deepEqual(firstJsonObject('{"a":1}\nDone {not json}.'), { a: 1 }));
test("braces inside strings and escapes", () =>
  assert.deepEqual(firstJsonObject('x {"a":"}{\\"}"} y'), { a: '}{"}' }));
test("skips prose braces before the object", () =>
  assert.deepEqual(firstJsonObject('use {curly} then {"k":true}'), { k: true }));
test("no JSON throws NoJsonError", () => {
  assert.throws(() => firstJsonObject("nothing here"), NoJsonError);
  assert.throws(() => firstJsonObject('{"a":'), NoJsonError);
  assert.throws(() => firstJsonObject("[1,2]"), NoJsonError);
  assert.throws(() => firstJsonObject(undefined), NoJsonError);
});
test("a broken outer object never yields an inner one", () => {
  assert.throws(() => firstJsonObject('{"a": {"b": 1}, oops}'), NoJsonError);
});

test("a trailing comma before } or ] is repaired", () => {
  assert.deepEqual(firstJsonObject('{"a":"x",\n}'), { a: "x" });
  assert.deepEqual(firstJsonObject('here: {"a":[1,2,],"b":{"c":3,},}\nthanks'), { a: [1, 2], b: { c: 3 } });
  assert.deepEqual(firstJsonObject('{"summary": "validated.",  },'), { summary: "validated." });
});
test("commas inside strings are left alone", () => {
  assert.deepEqual(firstJsonObject('{"a":"x,}", "b":"y, ]",}'), { a: "x,}", b: "y, ]" });
  assert.deepEqual(firstJsonObject('{"a":"say \\",}\\" now",}'), { a: 'say ",}" now' });
});
test("nothing else is repaired", () => {
  for (const bad of ["{a:1}", "{'a':1}", '{"a":1 "b":2}', '{"a":1,,}', '{,"a":1}', '{"a":1} {"b":', '{"a":/*x*/1}']) {
    if (bad === '{"a":1} {"b":') assert.deepEqual(firstJsonObject(bad), { a: 1 });
    else assert.throws(() => firstJsonObject(bad), NoJsonError, bad);
  }
});
