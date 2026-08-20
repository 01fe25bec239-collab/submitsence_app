/**
 * PB-10 Step 3 Phase 2d final review, CRITICAL 1: the throw-value matrix the
 * migration runner's error normalization must survive.
 *
 * JavaScript permits `throw x` for *any* x. The lifecycle boundary converts a
 * caught value to an Error from inside a `catch` that stands between an
 * already-acquired pooled client and its terminal `release()`, so a conversion
 * that can itself throw is a zero-disposition escape — the client stays checked
 * out forever and a bounded production pool loses the slot permanently.
 *
 * Two groups, because the guarantees differ:
 *
 *  - `diagnosticThrowValues` are values the language can convert without
 *    running any user code. Normalization must keep them *useful*: the text
 *    they carry has to reach the resulting Error's message.
 *  - `hostileThrowValues` are legal values whose conversion — or even whose
 *    `instanceof` probe — runs code that throws, or that the language itself
 *    refuses to convert. Normalization must degrade to a safe constant rather
 *    than fail, and the disposition must still happen.
 *
 * Shared by the unit suites for both ownership paths (the control client's,
 * through `runMigrationPlan`, and the execution client's, through
 * `executeMigrations`) so neither path can be hardened against a narrower set
 * of values than the other.
 */

/**
 * A throw injected into a fake client, held in a box so that *presence* rather
 * than truthiness arms it. `undefined`, `null`, `0`, `false` and `""` are all
 * legal `throw` operands, and a truthiness check would silently refuse to inject
 * exactly the values most likely to break a naive conversion.
 */
export type ThrowInjection = { readonly value: unknown } | undefined;

/** Arms a fake client's injection point with `value`, whatever `value` is. */
export function throws(value: unknown): ThrowInjection {
  return { value };
}

export interface ThrowValueCase {
  /** Reads as a sentence fragment inside a test name. */
  readonly name: string;
  /** Built fresh per case: several of these are single-use (a revoked Proxy). */
  readonly make: () => unknown;
}

/** Values whose conversion is defined by the language and runs no user code. */
export const diagnosticThrowValues: readonly ThrowValueCase[] = [
  { name: "a string", make: () => "the client refused its error listener" },
  { name: "a number", make: () => 42 },
  { name: "a bigint", make: () => 9007199254740993n },
  { name: "a boolean", make: () => true },
  { name: "undefined", make: () => undefined },
  { name: "null", make: () => null },
  { name: "a symbol", make: () => Symbol("listener refused") },
];

/**
 * Values that defeat naive normalization. Each one is a legal `throw` operand.
 *
 * `String(x)` performs ToPrimitive, which consults `Symbol.toPrimitive`, then
 * `valueOf`/`toString` — user code, or, on a null-prototype object, nothing at
 * all, at which point the language throws a TypeError of its own. A Proxy can
 * additionally break the `instanceof Error` *pre-check*, because that walks the
 * prototype chain through the `getPrototypeOf` trap; a revoked Proxy breaks
 * every operation on it at once.
 */
export const hostileThrowValues: readonly ThrowValueCase[] = [
  {
    name: "a null-prototype object with no primitive conversion at all",
    make: () => Object.create(null) as unknown,
  },
  {
    name: "an object whose Symbol.toPrimitive throws",
    make: () => ({
      [Symbol.toPrimitive]() {
        throw new Error("Symbol.toPrimitive refuses to answer");
      },
    }),
  },
  {
    name: "a null-prototype object whose own toString and valueOf both throw",
    make: () => Object.assign(Object.create(null) as object, {
      toString() {
        throw new Error("toString refuses to answer");
      },
      valueOf() {
        throw new Error("valueOf refuses to answer");
      },
    }),
  },
  {
    name: "a Proxy whose getPrototypeOf trap throws, defeating the instanceof probe itself",
    make: () => new Proxy({}, {
      getPrototypeOf() {
        throw new Error("getPrototypeOf refuses to answer");
      },
      get() {
        throw new Error("get refuses to answer");
      },
      has() {
        throw new Error("has refuses to answer");
      },
    }),
  },
  {
    name: "a revoked Proxy, where every operation but typeof throws",
    make: () => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    },
  },
];
