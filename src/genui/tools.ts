import { Type } from "typebox";

export const PRESENT_UI_TOOL_NAME = "present_ui";

export function presentUiParameterSchema() {
  return Type.Object({
    key: Type.Optional(Type.String({ description: "Artifact key (owner/id) in this project." })),
    version: Type.Optional(Type.Integer({ minimum: 1, description: "Version to show. Omit to show the current version." })),
    title: Type.Optional(Type.String({ description: "Title shown with the artifact. Defaults to the artifact title." })),
    program: Type.Optional(Type.String({ description: "Program or text to save as a session artifact. Requires manifest." })),
    manifest: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Publish manifest, including kind. Required with program." })),
  });
}

export function presentCardParameterSchema() {
  return Type.Object({
    title: Type.Optional(Type.String({ description: "Short title shown above the card." })),
    program: Type.String({ description: "The card program: live.declarative, markdown text (static.markdown), or a full HTML document (live.html)." }),
    manifest: Type.Record(Type.String(), Type.Unknown(), {
      description: "Manifest with kind. live.declarative: format, library, bindings: []. live.html: format html, optional libraries ({name, version}), empty csp. static.markdown: kind only.",
    }),
  });
}
