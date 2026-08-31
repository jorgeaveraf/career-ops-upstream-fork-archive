# Feedback and Calibration (V2E)

Calibration converts lifecycle evidence into bounded, explainable signals. It keeps these dimensions separate:

- user preference;
- market response;
- source quality;
- application effectiveness;
- community signal.

One observation never becomes a hard policy. Signals require a minimum evidence count, decay with age, include confidence and provenance, and are grouped by company or role family. Ranking adjustments are bounded. Stronger repeated evidence may create a policy **candidate** for human review, but the engine never mutates hard eligibility rules automatically.

Facebook monitoring metrics remain source/community evidence. A low-signal sample is recorded neutrally and cannot become a global conclusion about the job market.

Use:

```bash
npm run feedback:calibrate
```

The command rebuilds derived calibration signals from persisted lifecycle evidence. Source events and prior application/execution history remain auditable.
