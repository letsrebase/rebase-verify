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
