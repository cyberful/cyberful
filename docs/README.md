---
hide:
  - toc
---

<section class="cyberful-hero">
  <div>
    <div class="cyberful-eyebrow">Application-security workbench</div>
    <h1>Find what breaks before someone else does.</h1>
    <p class="cyberful-hero__lead">
      Cyberful guides an AI coding agent through authorized penetration tests,
      code audits, and bug bounty programs—from a precise scope to findings an
      independent verifier can reproduce.
    </p>
    <div class="cyberful-actions">
      <a class="md-button md-button--primary" href="getting-started/">Run your first test</a>
      <a class="md-button" href="user-guide/workflows/">Explore workflows</a>
    </div>
  </div>
  <div class="cyberful-terminal" role="img" aria-label="Terminal showing the global npm install command for Cyberful">
    <div class="cyberful-terminal__bar">
      <span class="cyberful-terminal__dot"></span>
      <span class="cyberful-terminal__dot"></span>
      <span class="cyberful-terminal__dot"></span>
      <span class="cyberful-terminal__label">cyberful · install</span>
    </div>
    <div class="cyberful-terminal__body">
      <div><span class="cyberful-terminal__prompt">$</span> npm i -g cyberful</div>
    </div>
  </div>
</section>

<div class="cyberful-proof">
  <div class="cyberful-proof__item"><strong>3 workflows</strong><span>Pentest, bug bounty, and code audit</span></div>
  <div class="cyberful-proof__item"><strong>Independent verification</strong><span>Evidence before conclusions</span></div>
  <div class="cyberful-proof__item"><strong>Zero telemetry</strong><span>Local state stays under your control</span></div>
</div>

<div class="cyberful-section-heading">
  <h2>Start with the job in front of you</h2>
  <p>No internal architecture knowledge required.</p>
</div>

<div class="cyberful-card-grid">
  <a class="cyberful-card" href="getting-started/requirements/">
    <span class="cyberful-card__number">01</span><span class="cyberful-card__arrow" aria-hidden="true">↗</span>
    <h3>Check the requirements</h3>
    <p>Prepare Docker, disk space, and one supported agent provider.</p>
  </a>
  <a class="cyberful-card" href="getting-started/install/">
    <span class="cyberful-card__number">02</span><span class="cyberful-card__arrow" aria-hidden="true">↗</span>
    <h3>Install Cyberful</h3>
    <p>Install the packaged CLI or launch a source checkout for development.</p>
  </a>
  <a class="cyberful-card" href="getting-started/">
    <span class="cyberful-card__number">03</span><span class="cyberful-card__arrow" aria-hidden="true">↗</span>
    <h3>Run an authorized test</h3>
    <p>Define exact targets and constraints, then follow the phase-by-phase run.</p>
  </a>
  <a class="cyberful-card" href="user-guide/workflows/">
    <span class="cyberful-card__number">04</span><span class="cyberful-card__arrow" aria-hidden="true">↗</span>
    <h3>Choose the right workflow</h3>
    <p>Match pentest, bug bounty, or code audit to the evidence you need.</p>
  </a>
</div>

<section class="cyberful-workflow">
  <div class="cyberful-workflow__header">
    <h2>One disciplined path from scope to report</h2>
    <a href="concepts/execution-model/">See the execution model →</a>
  </div>
  <div class="cyberful-phases" aria-label="Cyberful phase sequence">
    <div class="cyberful-phase">Brief</div>
    <div class="cyberful-phase">Recon</div>
    <div class="cyberful-phase">Exploit</div>
    <div class="cyberful-phase">Hacker</div>
    <div class="cyberful-phase">Verify</div>
    <div class="cyberful-phase">Report</div>
  </div>
</section>

<div class="cyberful-safety">
  <span class="cyberful-safety__mark" aria-hidden="true">!</span>
  <p><strong>Authorization is part of the system boundary.</strong> Use Cyberful only on systems you own or are explicitly authorized to test. Workareas, evidence, reports, browser profiles, and scanner state may contain sensitive data and must not be committed.</p>
</div>

## Go deeper

- [**Use Cyberful**](user-guide/workflows.md) for the terminal, sessions,
  evidence, reports, and agent providers.
- [**Understand the system**](concepts/architecture.md) for phases, isolation,
  handoffs, and safety boundaries.
- [**Operate the security tools**](runtimes/README.md) for cyberful-os, the
  browser, OWASP ZAP, Ghidra, and the EVM lab.
- [**Build with us**](development/README.md) for contributor workflows,
  testing, and releases.
