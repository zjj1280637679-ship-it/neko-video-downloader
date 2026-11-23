"""Runtime-adjustable admission, bounded lookahead, strictly ordered output."""
from __future__ import annotations

import concurrent.futures
import time

from common import MAX_CONCURRENCY


class Cancelled(Exception):
    pass


def ordered_dynamic_map(operation, items, control, observe=None, max_ahead=512):
    """Results stay on disk in callers; only small result descriptors queue here.

    Lowering the limit does not interrupt admitted work. Raising is observed even
    while the first item is slow. Completed out-of-order items do not occupy an
    active request slot, but the bounded lookahead prevents unbounded disk growth.
    """
    iterator = iter(items)
    futures, ready = {}, {}
    submitted = consumed = 0
    exhausted = False
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=MAX_CONCURRENCY)
    try:
        while not exhausted or futures or ready:
            state = control()
            if state.get('cancelled'):
                raise Cancelled()
            target = state['concurrency']
            if type(target) is not int or not 1 <= target <= MAX_CONCURRENCY:
                raise ValueError('Invalid concurrency control')
            for future in list(futures):
                if future.done():
                    index = futures.pop(future)
                    # Raise failed fragments before issuing more work. Never skip.
                    ready[index] = future.result()
            # Fill free network slots before the caller decrypts/writes the next
            # ordered result. That result still counts toward the lookahead cap.
            while not exhausted and len(futures) < target and submitted - consumed < max_ahead:
                try:
                    item = next(iterator)
                except StopIteration:
                    exhausted = True
                    break
                futures[pool.submit(operation, item)] = submitted
                submitted += 1
            if observe:
                observe(len(futures), submitted, consumed, state)
            if consumed in ready:
                while consumed in ready:
                    yield ready.pop(consumed)
                    consumed += 1
                    if not exhausted and not futures:
                        # A full lookahead window prevented any new admission.
                        # The acknowledged write just freed a slot.
                        break
                if observe:
                    observe(len(futures), submitted, consumed, state)
                continue  # Re-read control after returning from the consumer.
            if futures:
                concurrent.futures.wait(futures, timeout=0.05, return_when=concurrent.futures.FIRST_COMPLETED)
            elif not exhausted and not ready:
                time.sleep(0.01)
    finally:
        for future in futures:
            future.cancel()
        # The host owns process-tree cancellation, including blocked socket IO.
        pool.shutdown(wait=True, cancel_futures=True)
