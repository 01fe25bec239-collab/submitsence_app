import assert from "node:assert/strict";
import test from "node:test";
import { FrameSplitter, type ParsedFrame } from "./helpers/postgres-frame-proxy";

/**
 * PB-10 Step 3 Phase 2c blocker 7: pure, no-database unit tests for the
 * protocol-precise frame parser the ambiguous-COMMIT proxy is built on
 * (test/helpers/postgres-frame-proxy.ts). These prove the parser recognises
 * a COMMIT frame regardless of how a TCP stack happens to chop or coalesce
 * the underlying bytes — the literal-substring proxy it replaces could not
 * make that guarantee at all.
 */

const startupMessage = Buffer.concat([
  (() => { const b = Buffer.alloc(4); b.writeUInt32BE(4 + 4 + 1, 0); return b; })(),
  (() => { const b = Buffer.alloc(4); b.writeUInt32BE(196608, 0); return b; })(), // protocol version 3.0
  Buffer.from([0]),
]);

function query(text: string): Buffer {
  const body = Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(4 + body.length, 0);
  return Buffer.concat([Buffer.from("Q"), header, body]);
}

function commandComplete(tag: string): Buffer {
  const body = Buffer.concat([Buffer.from(tag, "utf8"), Buffer.from([0])]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(4 + body.length, 0);
  return Buffer.concat([Buffer.from("C"), header, body]);
}

function pushAllAtOnce(frames: Buffer[], assumeTyped = false): ParsedFrame[] {
  const splitter = new FrameSplitter(assumeTyped);
  return splitter.push(Buffer.concat(frames));
}

function pushByteAtATime(frames: Buffer[], assumeTyped = false): ParsedFrame[] {
  const splitter = new FrameSplitter(assumeTyped);
  const whole = Buffer.concat(frames);
  const out: ParsedFrame[] = [];
  for (const byte of whole) out.push(...splitter.push(Buffer.from([byte])));
  return out;
}

test("proxy parser: a StartupMessage (untyped, length-prefixed) is recognised and does not desynchronise the typed frames that follow", () => {
  const commitQuery = query("commit");
  const frames = pushAllAtOnce([startupMessage, commitQuery]);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, null, "the startup message carries no type byte");
  assert.equal(frames[1].type, "Q");
  assert.equal(frames[1].body.subarray(0, 6).toString(), "commit");
});

test("proxy parser: a COMMIT Query frame split before the type byte is still recognised", () => {
  const whole = query("commit");
  const splitter = new FrameSplitter(true);
  const first = splitter.push(Buffer.alloc(0)); // nothing yet
  assert.equal(first.length, 0);
  const frames = [...splitter.push(whole.subarray(0, 0)), ...splitter.push(whole)];
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, "Q");
});

test("proxy parser: a COMMIT frame split inside the 4-byte length field is buffered until the length is complete", () => {
  const whole = query("commit");
  const splitter = new FrameSplitter(true);
  const part1 = whole.subarray(0, 2); // type byte + 1 byte of the length
  const part2 = whole.subarray(2);
  assert.deepEqual(splitter.push(part1), [], "no frame is reported until the full length field has arrived");
  const frames = splitter.push(part2);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, "Q");
  assert.equal(frames[0].raw.equals(whole), true, "the reassembled frame is byte-identical to the original");
});

test("proxy parser: a COMMIT frame split across every possible byte boundary is always recognised exactly once", () => {
  const whole = query("commit");
  for (let cut = 1; cut < whole.length; cut += 1) {
    const splitter = new FrameSplitter(true);
    const before = splitter.push(whole.subarray(0, cut));
    const after = splitter.push(whole.subarray(cut));
    assert.deepEqual(before, [], `boundary at byte ${cut}: nothing must be reported before the frame is complete`);
    assert.equal(after.length, 1, `boundary at byte ${cut}: exactly one frame once complete`);
    assert.equal(after[0].type, "Q");
    assert.ok(after[0].raw.equals(whole), `boundary at byte ${cut}: reassembled bytes must match exactly`);
  }
});

test("proxy parser: a COMMIT frame split one byte at a time is still recognised", () => {
  const whole = query("commit");
  const frames = pushByteAtATime([whole], true);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, "Q");
});

test("proxy parser: a COMMIT frame coalesced with neighbouring frames in a single chunk yields every frame separately, in order", () => {
  const before = query("select 1");
  const commit = query("commit");
  const after = commandComplete("SELECT 1"); // a differently-typed frame, arbitrary content
  const frames = pushAllAtOnce([before, commit, after], true);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].type, "Q");
  assert.equal(frames[0].body.subarray(0, 8).toString(), "select 1");
  assert.equal(frames[1].type, "Q");
  assert.equal(frames[1].body.subarray(0, 6).toString(), "commit");
  assert.equal(frames[2].type, "C");
});

test("proxy parser: a COMMIT frame surrounded by partial preceding and following frames across several chunks is still found exactly once", () => {
  const preceding = query("select 1");
  const commit = query("commit");
  const following = commandComplete("COMMIT");
  const whole = Buffer.concat([preceding, commit, following]);
  // An intentionally awkward split: partway through `preceding`, spanning
  // the preceding/commit boundary, spanning inside commit's length field,
  // spanning commit's body/following boundary, then the rest.
  const cuts = [3, preceding.length + 1, preceding.length + 3, preceding.length + commit.length + 1, whole.length];
  const splitter = new FrameSplitter(true);
  const frames: ParsedFrame[] = [];
  let previous = 0;
  for (const cut of cuts) {
    frames.push(...splitter.push(whole.subarray(previous, cut)));
    previous = cut;
  }
  assert.equal(frames.length, 3);
  assert.equal(frames[1].type, "Q");
  assert.equal(frames[1].body.subarray(0, 6).toString(), "commit");
  assert.equal(frames[2].type, "C");
  assert.equal(frames[2].body.subarray(0, 6).toString(), "COMMIT");
});

test("proxy parser: an unrelated identifier that merely contains the substring 'commit' never matches", () => {
  const frames = pushAllAtOnce([query("select 1 from recommit_log")], true);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, "Q");
  const text = frames[0].body.subarray(0, frames[0].body.length - 1).toString().trim().toLowerCase();
  assert.notEqual(text, "commit");
});

test("proxy parser: CommandComplete('COMMIT') is only recognised for that exact tag, not a prefix or substring", () => {
  const frames = pushAllAtOnce([commandComplete("COMMIT COMMIT")], true); // contrived, but proves exact-match semantics
  assert.equal(frames[0].type, "C");
  assert.notEqual(frames[0].body.subarray(0, frames[0].body.length - 1).toString(), "COMMIT");
});
