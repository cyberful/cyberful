---
template: home.html
hide:
  - navigation
  - toc
---

<section class="cyberful-hero">
  <div class="cyberful-hero__copy">
    <div class="cyberful-eyebrow">Application-security workbench</div>
    <h1>Find what breaks before someone else does.</h1>
    <p class="cyberful-hero__lead">
      Guide an AI coding agent through authorized penetration tests, code
      audits, and bug bounty programs—from a precise scope to findings an
      independent verifier can reproduce.
    </p>
    <div class="cyberful-actions">
      <a class="md-button md-button--primary" href="getting-started/">Run your first test</a>
      <a class="md-button" href="user-guide/workflows/">Explore workflows</a>
    </div>
    <div class="cyberful-hero__signals" aria-label="Cyberful product principles">
      <span>Open source</span>
      <span>Local-first</span>
      <span>Zero telemetry</span>
    </div>
  </div>
  <figure class="cyberful-cli-visual">
    <img src="assets/cli-pixel-blob.png" alt="Abstract colorful pixel field inspired by the Cyberful CLI">
  </figure>
</section>

<section class="cyberful-home-section">
  <div class="cyberful-section-heading cyberful-section-heading--editorial">
    <div>
      <span class="cyberful-section-kicker">Workflows</span>
      <h2>Choose the work.<br>Keep the evidence standard.</h2>
    </div>
    <p>Each workflow has its own scope and safety contract. Every one ends with independently verified findings.</p>
  </div>

  <div class="cyberful-workflow-grid">
    <a class="cyberful-workflow-card" href="user-guide/workflows/#pentest">
      <span class="cyberful-workflow-card__meta">01 / Live target</span>
      <h3>Pentest</h3>
      <p>Move from an explicit brief through recon and exploitation to a report backed by reproducible evidence.</p>
      <span class="cyberful-workflow-card__chain">brief → recon → exploit → verify → report</span>
    </a>
    <a class="cyberful-workflow-card" href="user-guide/workflows/#bug-bounty-program">
      <span class="cyberful-workflow-card__meta">02 / Program scope</span>
      <h3>Bug bounty</h3>
      <p>Translate official program rules into a bounded engagement and a submission another researcher can reproduce.</p>
      <span class="cyberful-workflow-card__chain">program → test → evidence → submission</span>
    </a>
    <a class="cyberful-workflow-card" href="user-guide/workflows/#code-audit">
      <span class="cyberful-workflow-card__meta">03 / Source review</span>
      <h3>Code audit</h3>
      <p>Trace attack paths without writing to the checkout, using a disposable isolated lab only when verification needs it.</p>
      <span class="cyberful-workflow-card__chain">scope → trace → attack → verify → report</span>
    </a>
  </div>
</section>

<section class="cyberful-workflow">
  <div class="cyberful-workflow__header">
    <div>
      <span class="cyberful-section-kicker">Execution model</span>
      <h2>One disciplined path from scope to report</h2>
    </div>
    <a href="concepts/execution-model/">See how isolation works →</a>
  </div>
  <div class="cyberful-phases" aria-label="Cyberful phase sequence">
    <div class="cyberful-phase"><span>01</span>Brief</div>
    <div class="cyberful-phase"><span>02</span>Recon</div>
    <div class="cyberful-phase"><span>03</span>Exploit</div>
    <div class="cyberful-phase"><span>04</span>Hacker</div>
    <div class="cyberful-phase"><span>05</span>Verify</div>
    <div class="cyberful-phase"><span>06</span>Report</div>
  </div>
</section>

<section class="cyberful-home-section">
  <div class="cyberful-section-heading">
    <div>
      <span class="cyberful-section-kicker">Get started</span>
      <h2>From zero to a scoped run</h2>
    </div>
    <p>Three short steps. No internal architecture knowledge required.</p>
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
      <p>Install the CLI globally, then confirm the local runtime is ready.</p>
    </a>
    <a class="cyberful-card" href="getting-started/">
      <span class="cyberful-card__number">03</span><span class="cyberful-card__arrow" aria-hidden="true">↗</span>
      <h3>Run an authorized test</h3>
      <p>Define exact targets and constraints, then follow the phase-by-phase run.</p>
    </a>
  </div>
</section>

<div class="cyberful-safety">
  <span class="cyberful-safety__mark" aria-hidden="true">!</span>
  <p><strong>Authorization is part of the system boundary.</strong> Use Cyberful only on systems you own or are explicitly authorized to test. Workareas, evidence, reports, browser profiles, and scanner state may contain sensitive data and must not be committed.</p>
</div>

<section class="cyberful-home-section cyberful-home-section--deep">
  <div class="cyberful-section-heading">
    <div>
      <span class="cyberful-section-kicker">Documentation</span>
      <h2>Go deeper</h2>
    </div>
  </div>
  <div class="cyberful-deep-grid">
    <a href="user-guide/workflows/"><strong>Use Cyberful</strong><span>Terminal, sessions, evidence, reports, and providers.</span><i aria-hidden="true">→</i></a>
    <a href="concepts/architecture/"><strong>Understand the system</strong><span>Phases, isolation, handoffs, and safety boundaries.</span><i aria-hidden="true">→</i></a>
    <a href="runtimes/"><strong>Operate security tools</strong><span>Browser, OWASP ZAP, Ghidra, cyberful-os, and EVM.</span><i aria-hidden="true">→</i></a>
    <a href="development/"><strong>Build with us</strong><span>Contributor workflows, testing, and releases.</span><i aria-hidden="true">→</i></a>
  </div>
</section>
