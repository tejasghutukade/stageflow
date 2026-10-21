export function textResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function imageResult(
  mimeType: string,
  bytes: Buffer,
  identity: { runId: string; path: string; mimeType: string },
) {
  return {
    content: [
      {
        type: "image" as const,
        mimeType,
        data: bytes.toString("base64"),
      },
      {
        type: "text" as const,
        text: JSON.stringify(identity, null, 2),
      },
    ],
  };
}
