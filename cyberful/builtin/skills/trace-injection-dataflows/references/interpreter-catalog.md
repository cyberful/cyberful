# Interpreter Catalog

## SQL and ORM

Check raw queries, fragments, identifiers, ordering, limits, operators, JSON paths, full-text syntax, stored procedures, dynamic schema or table selection, migration tools, report builders, and ORM escape hatches. Parameterization protects values, not arbitrary identifiers or grammar.

## NoSQL and search

Check operator injection, JSON object versus scalar coercion, query DSL, scripts, aggregations, projections, regex, map-reduce, server-side JavaScript, index selection, pipeline stages, and Elasticsearch-like query-string or script features.

## LDAP and XPath

Use the correct filter versus distinguished-name escaping for LDAP. For XPath or XQuery, prefer variable binding and fixed expressions; check predicates, namespaces, functions, and alternate parsers.

## Shell and process

Distinguish direct program invocation with argument arrays from shell interpretation. Check shell flags, command strings, environment, PATH, working directory, executable selection, option injection, globbing, redirection, response files, and utilities that interpret argument values as code or paths.

## Templates and expression languages

Distinguish data interpolation from template source creation. Check server and client template compilation, expression languages, sandbox escapes, helper or filter registration, object traversal, reflection, class access, method invocation, and template loader paths.

## Code, dynamic loading, and serialization hooks

Check evaluation, dynamic import, reflection, plugin loading, object hooks, constructors, post-deserialization callbacks, build macros, notebook execution, and user-controlled module or class names.

## Logs, headers, mail, and spreadsheets

Check structured-log boundary breaking, log forging, terminal escapes, downstream query languages, CRLF header splitting, mail header and command boundaries, CSV/formula injection, and exported content opened by privileged users.

## Browser contexts

Route HTML, attribute, URL, JavaScript, CSS, SVG, DOM, and client-template contexts to `test-browser-security`. Encoding must match the final browser sink.
