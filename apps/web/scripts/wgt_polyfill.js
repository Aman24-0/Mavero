/*!
 * MAVERO — wgt polyfill (classic, ES5-safe; packed into the widget root by
 * scripts/wgt_patch_shell.mjs and loaded BEFORE ./app.js).
 *
 * WHY THIS EXISTS (TV evidence — UA43AUE60AKLXL / Tizen 6.0, boot overlay):
 *   "Uncaught TypeError: Object.hasOwn is not a function (source: file:///app.js)"
 *   → cascade: "classic bundle did not expose __mavero_wgt_app.start()".
 *
 * esbuild downlevels SYNTAX for build.target 'es2019' (vite.config.ts) but does
 * NOT polyfill BUILT-IN APIs. The TV's Chromium 69–76-era web engine lacks the
 * ES2021/ES2022 built-ins the single classic IIFE bundle (app.js) calls:
 *
 *   Object.hasOwn            ES2022, Chrome 93+   ← the boot crash
 *   String.prototype.replaceAll  ES2021, Chrome 85+
 *   WeakRef                  ES2021, Chrome 84+
 *   Object.fromEntries       ES2019, Chrome 73+   (borderline)
 *   globalThis               ES2020, Chrome 71+   (borderline; used in bundle)
 *   queueMicrotask           Chrome 71+           (borderline)
 *   Array/String .at()       ES2022, Chrome 92+
 *   Array.prototype.findLast/findLastIndex  ES2023, Chrome 97+
 *   Promise.allSettled       ES2020, Chrome 76+   (borderline)
 *   Promise.any              ES2021, Chrome 85+   (+ AggregateError, Chrome 85+)
 *   Array.prototype.flat/flatMap  ES2019, Chrome 69+ (borderline)
 *   structuredClone          Chrome 98+
 *   FinalizationRegistry     ES2021, Chrome 84+   (WeakRef's companion)
 *
 * #1 above throws during app.js MODULE EVALUATION → the IIFE never assigns the
 * window.__mavero_wgt_app global → the classic boot script's DOMContentLoaded
 * handler reports "classic bundle did not expose __mavero_wgt_app.start()".
 * Installing these globals BEFORE app.js evaluates fixes both errors.
 *
 * RULES for this file:
 *   - CLASSIC script (no import/export) — loaded via <script src="./polyfill.js">.
 *   - ES5 syntax ONLY (var/function, no arrows, no template literals, no
 *     let/const, no default params): it runs on the TV engine BEFORE any
 *     build-target question is settled — it must itself parse everywhere.
 *   - EVERY shim behind an `if missing` guard: on engines that already have the
 *     API (desktop Chromium, newer TVs) this file is a no-op.
 *   - Ship-accurate, not exhaustive: only built-ins the bundle (or plausible
 *     code paths) actually reference. Kept dependency-free and tiny.
 *
 * The production web app NEVER loads this file: it exists only as a pack-time
 * artifact of .github/workflows/build-wgt.yml (BUILD_TARGET=wgt).
 */

(function (global) {
  'use strict';

  var EMPTY_ERROR_MESSAGE = 'All promises were rejected';

  // -------------------------------------------------------------------------
  // Object.hasOwn — ES2022 (Chrome 93+). THE crash on the TV: the bundle
  // evaluates it at module scope, so this must be installed FIRST.
  // -------------------------------------------------------------------------
  if (typeof Object.hasOwn !== 'function') {
    Object.hasOwn = function (object, key) {
      // Spec: ToObject first, then the own-property check.
      return Object.prototype.hasOwnProperty.call(Object(object), key);
    };
  }

  // -------------------------------------------------------------------------
  // Object.fromEntries — ES2019 (Chrome 73+). Accepts any iterable of
  // [key, value] pairs (Map, Set of pairs, generators) plus array-likes.
  // -------------------------------------------------------------------------
  if (typeof Object.fromEntries !== 'function') {
    Object.fromEntries = function (entries) {
      var list = [];
      if (entries !== null && entries !== undefined) {
        if (typeof entries[Symbol.iterator] === 'function') {
          var iterator = entries[Symbol.iterator]();
          var step;
          while (!(step = iterator.next()).done) list.push(step.value);
        } else {
          list = Array.prototype.slice.call(entries);
        }
      }
      var result = {};
      for (var i = 0; i < list.length; i++) {
        var entry = list[i];
        if (entry !== null && entry !== undefined &&
            (typeof entry === 'object' || typeof entry === 'function')) {
          result[entry[0]] = entry[1];
        }
      }
      return result;
    };
  }

  // -------------------------------------------------------------------------
  // String.prototype.replaceAll — ES2021 (Chrome 85+). Spec semantics:
  //   - RegExp searchValue WITHOUT the global flag → TypeError (same as the
  //     native method);
  //   - global RegExp → delegate to replace();
  //   - string searchValue → literal replace-all. Implemented via an escaped
  //     global RegExp so `$` patterns in the string replacement ($$, $&, …)
  //     are processed exactly like the spec's GetSubstitution — a plain
  //     split/join would NOT do that.
  // -------------------------------------------------------------------------
  if (typeof String.prototype.replaceAll !== 'function') {
    String.prototype.replaceAll = function (searchValue, replaceValue) {
      if (searchValue instanceof RegExp) {
        if (!searchValue.global) {
          throw new TypeError(
            'String.prototype.replaceAll called with a non-global RegExp argument'
          );
        }
        return String.prototype.replace.call(this, searchValue, replaceValue);
      }
      var escaped = String(searchValue).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return String.prototype.replace.call(this, new RegExp(escaped, 'g'), replaceValue);
    };
  }

  // -------------------------------------------------------------------------
  // WeakRef — ES2021 (Chrome 84+). Functional shim: holds the target for as
  // long as the wrapper lives (no GC reclamation — acceptable inside a TV
  // widget whose engine never exposed the API in the first place; code that
  // merely caches via WeakRef keeps working).
  // -------------------------------------------------------------------------
  if (typeof global.WeakRef !== 'function') {
    var WeakRefShim = function (target) {
      if (!(this instanceof WeakRefShim)) {
        return new WeakRefShim(target);
      }
      this.__maveroTarget = target;
    };
    WeakRefShim.prototype.deref = function () {
      return this.__maveroTarget;
    };
    global.WeakRef = WeakRefShim;
  }

  // -------------------------------------------------------------------------
  // FinalizationRegistry — ES2021 (Chrome 84+), WeakRef's companion. No-op
  // shim: register()/unregister() must exist because code that constructs a
  // registry at module scope would otherwise crash before deref() ever runs.
  // Nothing is ever collected/cleaned up — fine for a widget process.
  // -------------------------------------------------------------------------
  if (typeof global.FinalizationRegistry !== 'function') {
    var FinalizationRegistryShim = function (cleanupCallback) {
      this.__maveroCleanup = cleanupCallback;
    };
    FinalizationRegistryShim.prototype.register = function () {
      /* no-op: nothing is reclaimed, so there is never a cleanup to run */
    };
    FinalizationRegistryShim.prototype.unregister = function () {
      return false; // never registered anything
    };
    FinalizationRegistryShim.prototype.cleanupSome = function () {
      /* no-op (non-standard, but the native API exposes it) */
    };
    global.FinalizationRegistry = FinalizationRegistryShim;
  }

  // -------------------------------------------------------------------------
  // globalThis — ES2020 (Chrome 71+). The bundle references it directly
  // (kit payload reads). Property assignment makes the identifier resolvable
  // in global scope (global-object properties are the identifier's scope).
  // -------------------------------------------------------------------------
  if (typeof global.globalThis === 'undefined') {
    global.globalThis = global;
  }

  // -------------------------------------------------------------------------
  // queueMicrotask — Chrome 71+. Promise-microtask approximation.
  // -------------------------------------------------------------------------
  if (typeof global.queueMicrotask !== 'function') {
    global.queueMicrotask = function (callback) {
      if (typeof callback !== 'function') {
        throw new TypeError('queueMicrotask expects a function');
      }
      Promise.resolve().then(callback);
    };
  }

  // -------------------------------------------------------------------------
  // Array.prototype.at / String.prototype.at — ES2022 (Chrome 92+).
  // -------------------------------------------------------------------------
  var atShim = function (index) {
    var n = typeof index === 'number' ? index : Number(index);
    if (isNaN(n)) n = 0;
    n = Math.trunc(n);
    if (n < 0) n += this.length;
    if (n < 0 || n >= this.length) return undefined;
    return this[n];
  };
  if (typeof Array.prototype.at !== 'function') {
    Object.defineProperty(Array.prototype, 'at', {
      value: atShim,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
  if (typeof String.prototype.at !== 'function') {
    Object.defineProperty(String.prototype, 'at', {
      value: atShim,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }

  // -------------------------------------------------------------------------
  // Array.prototype.findLastIndex / findLast — ES2023 (Chrome 97+).
  // -------------------------------------------------------------------------
  if (typeof Array.prototype.findLastIndex !== 'function') {
    Object.defineProperty(Array.prototype, 'findLastIndex', {
      value: function (predicate) {
        if (typeof predicate !== 'function') {
          throw new TypeError('predicate must be a function');
        }
        var thisArg = arguments.length > 1 ? arguments[1] : undefined;
        for (var i = this.length - 1; i >= 0; i--) {
          if (predicate.call(thisArg, this[i], i, this)) return i;
        }
        return -1;
      },
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
  if (typeof Array.prototype.findLast !== 'function') {
    Object.defineProperty(Array.prototype, 'findLast', {
      value: function (predicate) {
        if (typeof predicate !== 'function') {
          throw new TypeError('predicate must be a function');
        }
        var thisArg = arguments.length > 1 ? arguments[1] : undefined;
        for (var i = this.length - 1; i >= 0; i--) {
          if (predicate.call(thisArg, this[i], i, this)) return this[i];
        }
        return undefined;
      },
      writable: true,
      configurable: true,
      enumerable: false
    });
  }

  // -------------------------------------------------------------------------
  // Promise.allSettled — ES2020 (Chrome 76+, borderline on this engine).
  // -------------------------------------------------------------------------
  if (typeof Promise.allSettled !== 'function') {
    Promise.allSettled = function (promises) {
      var list = Array.prototype.slice.call(promises || []);
      return Promise.all(list.map(function (p) {
        return Promise.resolve(p).then(
          function (value) { return { status: 'fulfilled', value: value }; },
          function (reason) { return { status: 'rejected', reason: reason }; }
        );
      }));
    };
  }

  // -------------------------------------------------------------------------
  // AggregateError + Promise.any — ES2021 (Chrome 85+).
  // -------------------------------------------------------------------------
  if (typeof global.AggregateError !== 'function') {
    var AggregateErrorShim = function (errors, message) {
      var error = new Error(message !== undefined ? message : EMPTY_ERROR_MESSAGE);
      error.name = 'AggregateError';
      error.errors = Array.prototype.slice.call(errors || []);
      return error;
    };
    global.AggregateError = AggregateErrorShim;
  }
  if (typeof Promise.any !== 'function') {
    Promise.any = function (promises) {
      var list = Array.prototype.slice.call(promises || []);
      return new Promise(function (resolve, reject) {
        var remaining = list.length;
        var errors = [];
        if (remaining === 0) {
          reject(new global.AggregateError([], EMPTY_ERROR_MESSAGE));
          return;
        }
        list.forEach(function (p, index) {
          Promise.resolve(p).then(resolve, function (reason) {
            errors[index] = reason;
            remaining -= 1;
            if (remaining === 0) {
              reject(new global.AggregateError(errors, EMPTY_ERROR_MESSAGE));
            }
          });
        });
      });
    };
  }

  // -------------------------------------------------------------------------
  // Array.prototype.flat / flatMap — ES2019 (Chrome 69 exactly — borderline).
  // -------------------------------------------------------------------------
  if (typeof Array.prototype.flat !== 'function') {
    var flatten = function (source, depth) {
      var out = [];
      for (var i = 0; i < source.length; i++) {
        if (Array.isArray(source[i]) && depth > 0) {
          out = out.concat(flatten(source[i], depth - 1));
        } else {
          out.push(source[i]);
        }
      }
      return out;
    };
    Object.defineProperty(Array.prototype, 'flat', {
      value: function (depth) {
        var d = depth === undefined ? 1 : Number(depth);
        if (isNaN(d)) d = 1;
        return flatten(this, Math.max(0, Math.floor(d)));
      },
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
  if (typeof Array.prototype.flatMap !== 'function') {
    Object.defineProperty(Array.prototype, 'flatMap', {
      value: function (callback, thisArg) {
        return Array.prototype.concat.apply([], this.map(callback, thisArg));
      },
      writable: true,
      configurable: true,
      enumerable: false
    });
  }

  // -------------------------------------------------------------------------
  // structuredClone — Chrome 98+. Synchronous deep clone for the common
  // structured-clone types; throws (like the native method) for anything it
  // cannot clone honestly. NOT used by the current bundle — cheap insurance
  // for later code paths.
  // -------------------------------------------------------------------------
  if (typeof global.structuredClone !== 'function') {
    var DataCloneErrorShim = function (message) {
      var error = new Error(message);
      error.name = 'DataCloneError';
      return error;
    };
    var cloneValue = function (value, seen) {
      if (value === null || typeof value === 'undefined' ||
          typeof value === 'boolean' || typeof value === 'number' ||
          typeof value === 'string' || typeof value === 'bigint') {
        return value; // structured-cloneable primitives
      }
      if (typeof value === 'function' || typeof value === 'symbol') {
        // The native algorithm throws DataCloneError for these
        throw new DataCloneErrorShim(
          'structuredClone shim: ' + typeof value + ' cannot be cloned'
        );
      }
      if (seen.has(value)) return seen.get(value); // preserve cycles/identity
      var cloned;
      if (value instanceof Date) {
        cloned = new Date(value.getTime());
      } else if (value instanceof RegExp) {
        cloned = new RegExp(value.source, value.flags);
      } else if (value instanceof Map) {
        cloned = new Map();
        seen.set(value, cloned);
        value.forEach(function (v, k) { cloned.set(cloneValue(k, seen), cloneValue(v, seen)); });
      } else if (value instanceof Set) {
        cloned = new Set();
        seen.set(value, cloned);
        value.forEach(function (v) { cloned.add(cloneValue(v, seen)); });
      } else if (Array.isArray(value)) {
        cloned = [];
        seen.set(value, cloned);
        for (var i = 0; i < value.length; i++) cloned[i] = cloneValue(value[i], seen);
      } else if (Object.getPrototypeOf(value) === Object.prototype ||
                 Object.getPrototypeOf(value) === null) {
        cloned = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
        seen.set(value, cloned);
        for (var key in value) {
          if (Object.prototype.hasOwnProperty.call(value, key)) {
            cloned[key] = cloneValue(value[key], seen);
          }
        }
      } else {
        throw new DataCloneErrorShim(
          'structuredClone shim: value of this type cannot be cloned'
        );
      }
      return cloned;
    };
    global.structuredClone = function (value) {
      return cloneValue(value, new (global.WeakMap || Map)());
    };
  }

  // Diagnostic marker: the wgt boot smoke test asserts this flag to prove the
  // polyfill executed (and re-created the APIs the TV simulation deleted).
  global.__mavero_wgt_polyfill = true;
})(typeof window !== 'undefined' ? window : this);
