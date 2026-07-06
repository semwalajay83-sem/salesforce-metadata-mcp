export interface ToolLike {
  success: boolean;
  message: string;
  fullName?: string;
  created?: boolean;
  details?: string;
}

export function resultContent(result: ToolLike): {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    ...(result.success ? {} : { isError: true }),
  };
}
