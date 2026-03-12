export interface MinutePromptTemplate {
  template_id: string;
  name: string;
  description: string;
  prompt_body: string;
}

const BUILTIN_MINUTE_PROMPT_TEMPLATES: MinutePromptTemplate[] = [
  {
    template_id: "detailed-discussion-record",
    name: "Detailed Discussion Record",
    description: "Topic-organized minutes with speaker attribution for the key discussion points, proposals, and objections.",
    prompt_body: `Write the minutes as a detailed discussion record.

Priorities:
- Preserve the flow of the discussion by topic.
- Attribute important ideas, concerns, proposals, objections, and clarifications to the speakers who made them.
- Keep the notes concise, but do not flatten meaningful disagreement or tradeoffs.
- Capture decisions and TODO(Name): action items inline where they arose.

Preferred structure:
- \`# Meeting Minutes -- [Date]\`
- \`## Attendees\`
- \`## Topics Discussed\`
- one concrete \`### [Topic]\` section per major discussion thread
- optional \`## Summary\` only when it adds real value

Formatting rules:
- Use one attendee per bullet if you include attendees.
- Use canonical HL7 Jira links like [FHIR-34735](https://jira.hl7.org/browse/FHIR-34735).
- Normalize plain Jira IDs and messy issue URLs to the same canonical per-issue link.
- Avoid vague headings like \`Process\`, \`Discussion\`, \`Updates\`, or \`Miscellaneous\`.
- Prefer bullets over long prose paragraphs, but keep related bullets grouped under the right topic.
- When a decision happens, state it plainly and note who drove it if identifiable.`,
  },
  {
    template_id: "formal-working-group-minutes",
    name: "Formal Working Group Minutes",
    description: "Official working-group minutes with agenda flow, motions, vote counts, decisions, and follow-up items.",
    prompt_body: `Write the minutes as formal working-group minutes suitable for an official record.

Priorities:
- Follow the agenda progression when it is clear.
- Preserve motions, seconds, vote counts, approvals, dispositions, and formal outcomes exactly when they are stated.
- Capture decisions and TODO(Name): follow-ups inline under the relevant agenda item.
- Keep the tone factual, structured, and compact.

Preferred structure:
- \`# Meeting Minutes -- [Date]\`
- \`## Agenda\`
- \`## Attendees\`
- \`## Minutes Approval\` when applicable
- \`## Agenda Items\` or concrete topic sections
- optional \`## Summary\` at the end if it helps recap outcomes

Formatting rules:
- One attendee per bullet.
- Use canonical HL7 Jira links like [FHIR-34735](https://jira.hl7.org/browse/FHIR-34735).
- For tracker-heavy sections, record the tracker ID, title, disposition, rationale, and vote result if present.
- Preserve whether an item was approved, deferred, rejected, tabled, triaged, or left open.
- Avoid narrative filler; focus on official recordkeeping.
- Do not invent formal motions or vote counts that were not actually present.`,
  },
  {
    template_id: "action-oriented-minutes",
    name: "Action-Oriented Minutes",
    description: "Decisions, commitments, owners, deadlines, and blockers first, with only enough discussion to support them.",
    prompt_body: `Write the minutes as action-oriented meeting notes.

Priorities:
- Emphasize decisions, commitments, owners, deadlines, dependencies, and blockers.
- Include only enough discussion context to explain why an action or decision matters.
- Use inline \`TODO(Name): ...\` items at the point where the action arose.
- Surface unresolved questions and who needs to follow up.

Preferred structure:
- \`# Meeting Minutes -- [Date]\`
- \`## Attendees\`
- \`## Decisions\`
- \`## Open Questions\`
- \`## Topics Discussed\` only as needed

Formatting rules:
- Keep bullets terse and outcome-focused.
- Normalize FHIR tracker references to canonical HL7 Jira links like [FHIR-34735](https://jira.hl7.org/browse/FHIR-34735).
- If a discussion does not change a decision, action, risk, or blocker, summarize it very briefly.
- Avoid play-by-play narration unless it directly affects an outcome.
- Group actions under the topic or decision they belong to rather than in a separate action-item dump.`,
  },
  {
    template_id: "decision-journal",
    name: "Decision Journal",
    description: "Record substantive decisions, rationale, unresolved alternatives, and follow-up items with minimal narrative.",
    prompt_body: `Write the minutes as a decision journal.

Priorities:
- Capture each substantive decision or tentative consensus as its own record.
- Include the key rationale, alternatives considered, and anything explicitly left unresolved.
- Keep speaker attribution only where it clarifies ownership, authorship, or disagreement.
- Use inline \`TODO(Name): ...\` items for follow-up work linked to the relevant decision.

Preferred structure:
- \`# Meeting Minutes -- [Date]\`
- \`## Attendees\`
- \`## Decisions\`
- \`## Open Questions\`
- \`## Deferred / Follow-up Items\`

Formatting rules:
- Organize by decision, not by transcript chronology, unless chronology matters.
- Use concise bullets rather than long narrative sections.
- Normalize FHIR tracker references to canonical HL7 Jira links like [FHIR-34735](https://jira.hl7.org/browse/FHIR-34735).
- Avoid generic topic headings unless a real decision theme emerges.
- If no decision was reached, say so explicitly rather than implying consensus.`,
  },
  {
    template_id: "readable-narrative-digest",
    name: "Readable Narrative Digest",
    description: "A polished, readable digest of what happened, with light structure and less emphasis on speaker-by-speaker representation.",
    prompt_body: `Write the minutes as a readable narrative digest for someone who missed the meeting.

Priorities:
- Explain what was discussed, what changed, and what matters next.
- Keep the structure clean and readable rather than highly procedural.
- Use speaker attribution selectively for especially important statements, decisions, or disagreements.
- Preserve concrete decisions, TODO(Name): actions, and important tracker references.

Preferred structure:
- \`# Meeting Minutes -- [Date]\`
- \`## Summary\`
- \`## Attendees\`
- \`## Topics Discussed\`
- optional \`## Decisions\` and \`## Follow-up\` if they make the result clearer

Formatting rules:
- Favor compact prose or short bullets over exhaustive turn-by-turn notes.
- Normalize FHIR tracker references to canonical HL7 Jira links like [FHIR-34735](https://jira.hl7.org/browse/FHIR-34735).
- Keep the output polished and easy to skim, but do not drift into vague generalities.
- Avoid headings like \`Process\` or \`Miscellaneous\`; use specific subject matter instead.
- Do not lose concrete outcomes while making the notes more readable.`,
  },
];

export const DEFAULT_MINUTE_PROMPT_TEMPLATE_ID = "formal-working-group-minutes";

export function listMinutePromptTemplates(): MinutePromptTemplate[] {
  return BUILTIN_MINUTE_PROMPT_TEMPLATES.map((template) => ({ ...template }));
}

export function getMinutePromptTemplate(templateId: string | null | undefined): MinutePromptTemplate | null {
  if (!templateId) {
    return null;
  }
  const template = BUILTIN_MINUTE_PROMPT_TEMPLATES.find((candidate) => candidate.template_id === templateId);
  return template ? { ...template } : null;
}

export const DEFAULT_MINUTE_PROMPT_BODY =
  getMinutePromptTemplate(DEFAULT_MINUTE_PROMPT_TEMPLATE_ID)?.prompt_body ?? BUILTIN_MINUTE_PROMPT_TEMPLATES[0].prompt_body;
