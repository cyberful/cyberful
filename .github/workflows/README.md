# GitHub CI/CD

GitHub CI/CD is temporarily disabled. The verification, native build, CI, and
release definitions are preserved beside this file with a `.disabled` suffix,
so GitHub does not load or run them.

To activate the pipelines, remove the `.disabled` suffix from all four workflow
files. Their reusable-workflow references already target the resulting active
filenames. Then run `make typecheck test-bun test-python docs-build` locally
before pushing.
