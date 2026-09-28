import React from "react";
import { HOW_IT_WORKS_AUDIENCES, type HowItWorksAudience, type HowItWorksContent, type HowItWorksTrack } from "./content/howItWorks";
import { HowItWorksIcon } from "./howItWorksIcons";

// ── "How it works" infographic ──────────────────────────────────────────────
// A REAL UI component, not an image: it renders whatever `data` it is given
// (the CMS block of the home page, resolved through howItWorksContentOf, so
// the words and the icons are the admin's — or the canonical defaults when
// nothing was ever saved). Two tracks — buyers, sellers — four numbered steps
// each joined by one connector line, and a summary line each. Fully RTL
// (logical properties only), one column on a phone, two on a desktop.
// No call to action lives here on purpose: the seller sign-up button already
// sits elsewhere on the page.

function Track({ audience, track }: { audience: HowItWorksAudience; track: HowItWorksTrack }) {
  return (
    <div className="hiw-track" data-testid={`hiw-track-${audience}`} data-audience={audience}>
      <h3 className="hiw-track-title" data-testid={`hiw-track-title-${audience}`}>{track.title}</h3>
      <ol className="hiw-steps" data-testid={`hiw-steps-${audience}`}>
        {track.steps.map((step, i) => (
          <li className="hiw-step" key={`${i}-${step.icon}`} data-testid={`hiw-step-${audience}-${i + 1}`} data-step={i + 1} data-icon={step.icon}>
            <span className="hiw-icon">
              <HowItWorksIcon icon={step.icon} />
              <span className="hiw-num" aria-hidden="true">{i + 1}</span>
            </span>
            <span className="hiw-text">{step.text}</span>
          </li>
        ))}
      </ol>
      <p className="hiw-summary" data-testid={`hiw-summary-${audience}`} data-icon={track.summary.icon}>
        <span className="hiw-summary-icon"><HowItWorksIcon icon={track.summary.icon} size={18} /></span>
        <span>{track.summary.text}</span>
      </p>
    </div>
  );
}

export function HowItWorksInfographic({ data, id, testId }: { data: HowItWorksContent; id?: string; testId?: string }) {
  return (
    <section className="landing-section hiw" id={id || "how"} data-testid={testId || "how-it-works"} data-block-type="how_it_works">
      <h2 data-testid="hiw-title">{data.title}</h2>
      <div className="hiw-tracks">
        {HOW_IT_WORKS_AUDIENCES.map((audience) => <Track key={audience} audience={audience} track={data[audience]} />)}
      </div>
    </section>
  );
}
