/* Online search of the measured aggregate-throughput response V(N).
 * No transfer outcomes, retry counts, memory limits or production concurrency
 * ceiling enter this controller. The scheduler clips its integer target to the
 * remaining work and supplies occupied network windows with an unchanged
 * target. Actual N is time-weighted request occupancy and may be fractional.
 */
(function (root) {
  "use strict";

  // Three windows give a median (and a median absolute deviation) without
  // letting a single unusual window determine a response-curve point.
  const WINDOWS_PER_POINT = 3;
  // Below this gain, extra workers do not establish a useful improvement.
  // Compare with the epoch's highest rate, never a series of weaker neighbors.
  const RELATIVE_GAIN = 0.03;
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const validConcurrency = (n) => Number.isFinite(n) && n > 0;
  const integerTarget = (n) => Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(n)));
  const copyPoint = (point) => point ? { ...point } : null;

  class ThroughputController {
    constructor({ initialConcurrency = 1 } = {}) {
      if (!Number.isSafeInteger(initialConcurrency) || initialConcurrency <= 0) {
        throw new RangeError("initialConcurrency must be a positive safe integer");
      }
      this.targetConcurrency = initialConcurrency;
      this._curve = new Map();
      this._knownTargets = new Set();
      this._epochBest = null;
      this._samples = [];
      this._sampleTarget = null;
      this._phase = "observing";
      this._best = null;
      this._lastObservation = null;
      this._lastDecision = { reason: "collect initial response point", targetConcurrency: initialConcurrency };
      this._accepted = 0;
      this._rejected = 0;
      this._steadyPoints = 0;
      this._trackingDirection = 1;
      this._trackingAnchor = null;
      this._steadyReference = null;
    }

    observe(observation) {
      const { concurrency, bytesPerSecond } = observation || {};
      if (!validConcurrency(concurrency) || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
        // A zero-speed/stalled window cannot establish a log-throughput slope.
        // Break the batch rather than combine measurements across a stall.
        this._rejected += 1;
        this.discardPendingSamples();
        return this.targetConcurrency;
      }
      this._accepted += 1;
      const probeTarget = this.targetConcurrency;
      this._lastObservation = { concurrency, bytesPerSecond, probeTarget };
      // Refill gaps make actual occupancy vary slightly even at one unchanged
      // target. Group by that target; never round actual N into a claimed count.
      if (probeTarget !== this._sampleTarget) {
        this._sampleTarget = probeTarget;
        this._samples = [];
      }
      this._samples.push({ concurrency, bytesPerSecond });
      if (this._samples.length < WINDOWS_PER_POINT) return this.targetConcurrency;

      const speed = median(this._samples.map((sample) => sample.bytesPerSecond));
      const point = {
        concurrency: median(this._samples.map((sample) => sample.concurrency)),
        probeTarget,
        bytesPerSecond: speed,
        noise: median(this._samples.map((sample) => Math.abs(sample.bytesPerSecond - speed))),
        observedAt: this._accepted
      };
      this._samples = [];
      if (this._phase === "tracking" && this._trackingAnchor && probeTarget !== this._trackingAnchor.probeTarget) {
        return this._finishTracking(point);
      }

      if (this._phase === "steady" && this._best && probeTarget === this._best.probeTarget) {
        this._recordPoint(point);
        this._best = point;
        if (this._steadyReference && this._different(point, this._steadyReference)) {
          // A changed anchor invalidates cross-concurrency comparisons from the
          // previous network conditions. Rebuild instead of chasing old maxima.
          this._startEpoch([point]);
          return this._chooseNext();
        }
        this._steadyPoints += 1;
        if (this._steadyPoints < WINDOWS_PER_POINT) {
          return this._setTarget(probeTarget, "steady", "repeat the measured best point");
        }
        this._steadyPoints = 0;
        this._trackingAnchor = point;
        const direction = probeTarget === 1 ? 1 : this._trackingDirection;
        this._trackingDirection = -direction;
        const neighbors = [...this._knownTargets]
          .filter((target) => direction * (target - probeTarget) > 0)
          .sort((a, b) => direction * (a - b));
        const next = neighbors.length ? neighbors[0]
          : direction > 0 ? probeTarget * Math.SQRT2 : Math.floor(probeTarget / Math.SQRT2);
        return this._setTarget(next, "tracking", neighbors.length
          ? "remeasure a neighboring response point after repeated steady measurements"
          : "probe a half-octave beyond the fresh measured response curve");
      }

      this._recordPoint(point);
      return this._chooseNext();
    }

    discardPendingSamples() {
      // The sampler calls this when a window is ineligible (for example while
      // writing is stalled). Its reason never enters the response-curve model.
      this._samples = [];
      this._sampleTarget = null;
    }

    _different(a, b) {
      // Drift requires twice the useful-gain margin against a fixed reference.
      // Identical samples inside a batch (MAD=0) do not make tiny inter-batch
      // jitter a network change; slow accumulated drift still reaches this gate.
      return Math.abs(a.bytesPerSecond - b.bytesPerSecond)
        > 2 * RELATIVE_GAIN * b.bytesPerSecond + a.noise + b.noise;
    }

    _better(a, b) {
      const peak = this._epochBest ? this._epochBest.bytesPerSecond
        : Math.max(a.bytesPerSecond, b.bytesPerSecond);
      return a.bytesPerSecond - b.bytesPerSecond > RELATIVE_GAIN * peak + a.noise + b.noise;
    }

    _recordPoint(point) {
      this._curve.set(point.probeTarget, point);
      this._knownTargets.add(point.probeTarget);
      if (!this._epochBest || point.bytesPerSecond > this._epochBest.bytesPerSecond) {
        this._epochBest = point;
      }
    }

    _startEpoch(points) {
      this._curve = new Map();
      this._epochBest = null;
      this._steadyReference = null;
      this._steadyPoints = 0;
      // Keep measured coordinates for nearby re-probes, but no old velocities
      // enter the rebuilt response curve after a confirmed conditions change.
      points.forEach((point) => this._recordPoint(point));
    }

    _finishTracking(point) {
      const anchor = this._trackingAnchor;
      this._trackingAnchor = null;
      const previousProbe = this._curve.get(point.probeTarget);
      this._recordPoint(anchor);
      this._recordPoint(point);
      const movedUp = point.probeTarget > anchor.probeTarget;
      // A lower target must remain near the epoch peak, not merely near today's
      // anchor. Otherwise repeated 3% concessions could accumulate a large loss.
      const usefulChange = movedUp ? this._better(point, anchor) : !this._better(this._epochBest, point);
      if (usefulChange) {
        const changedCurve = movedUp || (previousProbe && this._different(point, previousProbe));
        if (changedCurve) this._startEpoch([anchor, point]);
        return this._chooseNext();
      }
      this._best = anchor;
      this._steadyPoints = 0;
      return this._setTarget(anchor.probeTarget, "steady", "neighboring probe did not improve the operating point");
    }

    _chooseNext() {
      const points = [...this._curve.values()].sort((a, b) => a.probeTarget - b.probeTarget);
      const highest = points.reduce((a, b) => b.bytesPerSecond > a.bytesPerSecond ? b : a);
      // On an indistinguishable plateau prefer the least measured concurrency.
      const best = points.find((point) => !this._better(this._epochBest, point)) || highest;
      this._best = best;
      const index = points.indexOf(best);
      const lower = points[index - 1];
      const upper = points[index + 1];

      if (!upper) {
        if (!lower) {
          return this._setTarget(best.probeTarget * 2, "exploring", "bootstrap the second response point");
        }
        // Adjacent target bands may overlap in actual occupancy. A slope must
        // use increasing *measured* N, so choose a separated measured coordinate.
        const slopeBase = points.slice(0, index).reverse().find((candidate) =>
          candidate.concurrency < best.concurrency && this._better(best, candidate));
        if (!slopeBase) {
          return this._setTarget(best.probeTarget * Math.SQRT2, "exploring", "separate actual occupancy coordinates for a measurable trend");
        }
        // e = d(log V) / d(log actual N). Search up to one doubling interval,
        // scaled by elasticity: targetNext = ceil(target * 2^clamp(e, 0, 1)).
        // Linear scaling doubles; diminishing returns shorten the probe. Using
        // a full log interval avoids slow crawling after two nearby probes.
        const elasticity = Math.log(best.bytesPerSecond / slopeBase.bytesPerSecond)
          / Math.log(best.concurrency / slopeBase.concurrency);
        let next = integerTarget(best.probeTarget * 2 ** Math.max(0, Math.min(1, elasticity)));
        // Only floating-point/integer resolution can erase a positive step.
        if (next === best.probeTarget && next < Number.MAX_SAFE_INTEGER) next += 1;
        return this._setTarget(next, "exploring", "extend the measured throughput trend", elasticity);
      }

      if (!lower && best.probeTarget > 1) {
        // No lower bracket exists (for example after a capacity change). A
        // geometric probe discovers it without assuming a starting worker cap.
        return this._setTarget(Math.floor(best.probeTarget / 2), "refining", "find the lower side of the measured peak or plateau");
      }

      const leftGap = lower ? best.probeTarget - lower.probeTarget : 0;
      const rightGap = upper.probeTarget - best.probeTarget;
      if (Math.max(leftGap, rightGap) > 1) {
        const a = leftGap >= rightGap ? lower.probeTarget : best.probeTarget;
        const b = leftGap >= rightGap ? best.probeTarget : upper.probeTarget;
        return this._setTarget(Math.floor(a + (b - a) / 2), "refining", "shrink the unresolved interval beside the measured best point");
      }

      // Both neighboring integers are measured, or N=1 is the lower boundary.
      // This is a local response-curve optimum, not a global-optimum guarantee.
      this._steadyPoints = 0;
      this._steadyReference = best;
      return this._setTarget(best.probeTarget, "steady", "neighboring response points bound a local peak or plateau");
    }

    _setTarget(target, phase, reason, elasticity) {
      this.targetConcurrency = integerTarget(target);
      this._phase = phase;
      this._lastDecision = { reason, targetConcurrency: this.targetConcurrency };
      if (Number.isFinite(elasticity)) this._lastDecision.elasticity = elasticity;
      return this.targetConcurrency;
    }

    snapshot() {
      return {
        targetConcurrency: this.targetConcurrency,
        phase: this._phase,
        estimatedBest: copyPoint(this._best),
        epochBest: copyPoint(this._epochBest),
        relativeGainTolerance: RELATIVE_GAIN,
        lastObservation: copyPoint(this._lastObservation),
        lastDecision: { ...this._lastDecision },
        acceptedObservations: this._accepted,
        rejectedObservations: this._rejected,
        pendingSamples: this._samples.length,
        curve: [...this._curve.values()].sort((a, b) => a.probeTarget - b.probeTarget).map(copyPoint),
        knownProbeTargets: [...this._knownTargets].sort((a, b) => a - b)
      };
    }
  }

  const api = { ThroughputController };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.NekoAdaptive = Object.assign(root.NekoAdaptive || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this);
