# Injection Field Heuristics

## Interpreter-stack model

List every parser in order, for example:

`HTTP -> JSON -> schema coercion -> template/substitution -> query builder -> database`

or

`archive -> filename decoding -> path normalization -> shell wrapper -> child argv`

For each boundary record bytes/chars received, decoding, canonicalization, grammar role, structural API, and error behavior. Mutation is useful only when it distinguishes which parser gained structural control.

## Backward-first sink review

Start at process creation, dynamic query/selector, template compile/render, expression evaluation, path dispatch, logging parser, spreadsheet formula export, mail/header construction, or code/module load. Enumerate all wrappers and callers; identify which arguments are structure, identifiers, data, environment, working directory, and options. Parameterization of values does not protect attacker-controlled identifiers, operators, sort clauses, field paths, or pipeline stages.

## Second-order patterns

- value safely stored, later concatenated into maintenance/report/admin query;
- log field later ingested by a command, query, template, or alert rule;
- filename/metadata later used by converter, backup, antivirus, or shell job;
- tenant-defined template/rule/filter compiled under a stronger service identity;
- queue/event payload validated by producer but interpreted differently by consumer version;
- escaped text decoded by import/export, spreadsheet, markup, or notification stage;
- persisted URL or header used by a server-side integration after approval.

Tag values with unique syntax-neutral markers and follow storage/job identifiers across time.

## Structural differential pairs

Change one semantic property:

- data value versus identifier/operator;
- literal versus parameter/bind variable;
- one parse versus double decode;
- scalar versus duplicate/list/object;
- direct request versus stored/replayed value;
- shell string versus argument vector;
- render value versus template source;
- trusted constant grammar versus attacker-selected grammar fragment;
- accepted input versus rejected input with identical downstream effect.

## Blind confirmation discipline

Use randomized paired timing samples, alternating controls, enough repetitions to separate baseline variance, and a minimal delay. For out-of-band evidence, correlate a per-attempt token, exact source action, protocol, timestamp, and receiver logs. DNS or HTTP traffic proves server-side interaction only after redirect/DNS/proxy and background-scanner alternatives are excluded.

## False-negative traps

Sanitizer applied before final decode, wrapper omitted from taint model, ORM raw escape hatch, identifier injection dismissed because values are parameterized, persistence-mediated flow, async consumer, server-side template compiled only in a rare locale/theme, logging/export path omitted, native/FFI boundary, and parser errors swallowed by fallback logic.
