export function guideUrlAfterSession(sessionId: string): { session: string } {
  return { session: sessionId };
}

export function guideUrlAfterNewChat(): { session?: undefined } {
  return {};
}
