export const DEFAULT_MINUTE_PROMPT_BODY = `Use this structure while the meeting is in progress:

\`\`\`markdown
# Meeting Minutes -- [Date]

## Attendees
- Lloyd McKenzie (host)
- Rick Geimer (co-host, scribe)
- Grahame Grieve
- Brian Postlethwaite

## Topics Discussed

### [Topic Title]
- Key points
- Decisions made
- Tracker items use canonical HL7 Jira links, e.g. [FHIR-34735](https://jira.hl7.org/browse/FHIR-34735)
- TODO(Name): action item written inline at the point where it came up
\`\`\`

Keep the minutes concise. Summarize instead of transcribing verbatim.

Formatting and style rules:
- Keep action items inline as \`TODO(Name): ...\` bullets under the relevant topic.
- If you include an \`## Attendees\` section, use one attendee per bullet. Never collapse many names into one comma-separated mega-bullet.
- Try hard to recognize FHIR tracker references and normalize them to canonical HL7 Jira links like [FHIR-34735](https://jira.hl7.org/browse/FHIR-34735).
- Normalize both plain issue mentions like \`FHIR-34735\` and messy Jira URLs or other noisy issue URLs to the same canonical per-issue link.
- Attribute key statements and action items to speakers when identified.
- Organize by topic. When discussion shifts, start a new topic section.
- Avoid vague section titles like \`Process\`, \`Discussion\`, \`Updates\`, or \`Miscellaneous\`. Prefer a concrete subject-matter title, or keep the content under the current section if no specific title fits.`;

export const DEFAULT_MINUTE_FINAL_PROMPT_BODY = `Finalize \`minutes.md\` with these cleanup rules:

- Add a \`## Summary\` section at the end with a concise 3-5 sentence overview of what was discussed, what was decided, and what remains open.
- Highlight the most important decisions and any deadlines mentioned.
- Review all inline \`TODO(Name): ...\` items, keep them inline under the relevant topics, and deduplicate them.
- Review the \`## Attendees\` section and keep it one person per bullet. Do not use a single comma-separated bullet of names.
- Normalize specific FHIR issue references to canonical HL7 Jira links like [FHIR-34735](https://jira.hl7.org/browse/FHIR-34735).
- If the draft contains a noisy Jira URL for a specific issue, replace it with the canonical per-issue link.
- Do a final pass for clarity and organization, but keep the structure that was built during the meeting.
- Rename vague section titles like \`Process\`, \`Discussion\`, \`Updates\`, or \`Miscellaneous\` to something concrete if the underlying topic is clear.`;
