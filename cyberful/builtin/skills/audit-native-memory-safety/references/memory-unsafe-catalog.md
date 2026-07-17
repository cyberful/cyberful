# Native Memory-Safety Review Catalog

## Spatial Safety

Inspect array indexing, pointer arithmetic, slices, iterators, length-delimited strings, flexible array members, structure packing, scatter/gather I/O, vectorized operations, image dimensions, decompression output, and nested offsets.

Track allocation-size equations independently from copy-size equations. Verify multiplication before addition, rounding and alignment, header sizes, element widths, and maximum representable values.

## Temporal Safety

Inspect error cleanup, asynchronous callbacks, event-loop watchers, reference counting, observer lists, caches, object pools, handle tables, deferred destruction, cancellation, and reentrancy. Look for:

- use-after-free;
- double free;
- stale iterator or pointer;
- ABA and generation reuse;
- refcount underflow or overflow;
- ownership mismatch across FFI;
- callback firing after context shutdown.

## Type, Format, and Initialization

Review unions, downcasts, tag/type consistency, serialization tags, vtable or function pointer storage, variadic calls, format strings, uninitialized padding, partial structure initialization, and ABI mismatch.

Format strings matter beyond printf: logging, localization, SQL wrappers, diagnostics, and platform APIs can interpret attacker-controlled format metadata.

## Integer and Logic Edges

Check signed/unsigned comparison, truncation, negative-to-size conversion, shift width, endian conversion, sentinel values, off-by-one, units, and 32/64-bit variation.

## Advanced Hints

- Bounds validated on compressed or encoded length may not constrain expanded length.
- A parser can validate each field but overflow when combining several valid fields.
- Integer promotion rules can make an apparently wide destination irrelevant because multiplication occurred at a narrow width.
- Error paths receive less fuzz coverage and often violate ownership.
- A safe Rust wrapper can be unsound when FFI aliases, lengths, thread-safety markers, or lifetimes are declared incorrectly.
- Concurrency bugs become memory corruption when one thread invalidates storage another treats as stable.
- Custom allocators and object pools change reuse predictability and can turn stale handles into type confusion.
