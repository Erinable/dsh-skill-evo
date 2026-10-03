## Requirements

R1. WHEN a command-capable ordinary tool call is observed THE SYSTEM SHALL append only the approved optional summaries `argKeys`, a redacted bounded `command`, and `commandTruncated` to the `tool/call` Observation, without appending complete arguments, descriptions, stdout, stderr, workdir, query, or fragment values.

R2. WHEN a command result is observed THE SYSTEM SHALL append structured `exitCode`, `signal`, and `timedOut` values when available and SHALL append a redacted bounded `errorLine` only when the result is failed, non-zero, signalled, or timed out; the existing `failed` meaning SHALL remain unchanged.

R3. WHEN any approved summary or error line is persisted THE SYSTEM SHALL apply the shared `redactSensitiveText` rules R1–R7 before tokenization or truncation, including URL userinfo, URL query/fragment, authorization headers, credential flags, credential environment assignments, and known token formats; repeated redaction SHALL be idempotent and legacy Observations SHALL remain readable.

R4. WHEN a session contains command summaries and results THE SYSTEM SHALL build ToolAttempt values by correlation, classify outcomes in the projection layer, and SHALL recognize a Correction episode only when the same normalized intent has at least `minFailures` failures followed by success within `maxAttemptsToSuccess`; a missing result SHALL be `unknown` and SHALL not form an episode.

R5. WHEN a Correction episode is recognized THE SYSTEM SHALL persist it as a Derived record with stable references to its session, Observation ids, recognizer version, input hash, normalized error signature, correction actions, environmental flag, and retry-only flag, and SHALL emit one Experience with tool attribution even when the session loaded no Skill.

R6. WHEN an error signature is normalized THE SYSTEM SHALL include the failed exit code and normalized first error line as structured signature dimensions, remove volatile values while retaining meaningful host/port and exit-code distinctions, and SHALL use the stable Failure cluster id rules from ADR-0022 as the cross-projection anchor wherever a Failure cluster is referenced.

R7. WHEN the correction rules, policy, classifier version, or Classification memo fingerprint changes THE SYSTEM SHALL update one cursor `derivationKey` and reproject correction Derived records without mutating Observations or memos; Projection SHALL never invoke an injected classifier.

R8. WHEN Correction episodes are projected THE SYSTEM SHALL aggregate equal signature keys into patterns whose id is `pattern:<earliest episode id>` after stable `(occurredAt, episodeId)` ordering, retain occurrences and total session evidence, and compute time-window counts, candidate status, and target Skill at read time from the supplied `now`, current policy, and proposal ledger.

R9. WHEN pattern assessment is requested THE SYSTEM SHALL apply the versioned CorrectionPolicy defaults `N=2`, `K=3`, `D=30` days, `maxAttemptsToSuccess=20`, and allowed scopes `project|user`; it SHALL exclude retry-only patterns, expire evidence outside the window, restart counting after a promotion, and report blocking in-progress proposals.

R10. WHEN failures or metrics are rendered THE SYSTEM SHALL expose recognizer and policy versions, episode and pattern counts, window session count versus K, count start, candidate decision, rejection reason, and target decision using the same pure assessment result.

R11. WHEN a human invokes design from an eligible pattern THE SYSTEM SHALL select patch-content or create-skill using the ordered target rules (previously promoted target, explicit `--skill`, majority loaded Skill, portfolio similarity, otherwise new Skill), SHALL pass only redacted summaries to the Designer, and SHALL reject non-neutral candidates containing observed environment values or `[REDACTED]`.

R12. WHEN a create-skill Proposal is created THE SYSTEM SHALL set `operation=create-skill`, `baseVersion=absent`, and `expectedBase.contentHash=absent`; all Base checks SHALL require the Skill to remain absent, and a competing creation SHALL fail with `stale-base`.

R13. WHEN a pattern-derived Proposal is created THE SYSTEM SHALL include its pattern id, signature key, episode ids, target rationale, and evidence Observation ids, SHALL use the existing transition table and ADR-0021 record-id rules, and SHALL leave the transfer table unchanged under ADR-0004.

R14. WHEN a create-skill or environmental pattern patch is evaluated THE SYSTEM SHALL run original-failure, historical-success where available, and high-severity boundary cases against both Base and Candidate; an absent Base SHALL be evaluated as a real empty-Skill baseline and SHALL preserve invocation-policy checks.

R15. WHEN a pattern-derived Proposal has no passing evaluation gate THE SYSTEM SHALL reject accept and promote; accept SHALL remain an explicit human operation and recognizers or Designers SHALL have no path to accept or promote.

R16. WHEN promotion is requested for create-skill or an environmental pattern patch THE SYSTEM SHALL allow only `project` or `user` by default, reject `stable` (and other disallowed scopes) in dry-run and real mode before writing versions or records, and SHALL keep candidate content conditional rather than embedding machine-specific proxy credentials, hosts, or addresses.

R17. WHEN the end-to-end fixture contains one session with three 443 failures followed by proxy setup and success THE SYSTEM SHALL produce an Experience but no eligible candidate; WHEN K=3 distinct recent sessions contain the same signature THE SYSTEM SHALL produce a create-skill candidate with absent Base; every persisted artifact SHALL omit the proxy username and password.

R18. WHEN a caller changes the recognizer version and reprojects the same Observations THE SYSTEM SHALL update correction Derived outputs and metrics to the new recognizer result while leaving the Observation log byte-for-byte unchanged.

R19. WHEN the repository implements this change THE SYSTEM SHALL preserve the core/bundle dependency direction, keep complete tool output out of the Observation log, keep runtime collection append-only and non-blocking, and leave Skill/memory/workflow boundaries as documented in CONTEXT.md.
