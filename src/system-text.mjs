// User-role text the framework injects, not the person's own words: task
// notifications and the compaction request and continuation turns.
export const SYSTEM_PROMPT_RE = /^(<task-notification>|Your task is to create a detailed summary of the conversation|This session is being continued from a previous conversation)/i;
