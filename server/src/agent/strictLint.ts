// Offline guard for Anthropic strict tool schemas (strict:true): unsupported keywords and complexity limits
// are caught by a unit test instead of a live 400.
const UNSUPPORTED = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', '$schema', 'patternProperties'];
export const STRICT_LIMITS = { optionalProperties: 24, unions: 16 } as const;

export function lintStrictSchema(schema: unknown): string[] {
  const issues: string[] = [];
  let optional = 0;
  let unions = 0;
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    for (const k of UNSUPPORTED) if (k in n) issues.push(`${path}: unsupported keyword '${k}'`);
    if (typeof n.minItems === 'number' && n.minItems > 1) issues.push(`${path}: minItems > 1 is not supported`);
    if (n.type === 'object' || 'properties' in n) {
      if (n.additionalProperties !== false) issues.push(`${path}: objects must set additionalProperties: false`);
      const props = Object.keys((n.properties as object) ?? {});
      const required = new Set((n.required as string[]) ?? []);
      optional += props.filter((p) => !required.has(p)).length;
    }
    if (Array.isArray(n.anyOf) || Array.isArray(n.oneOf) || (Array.isArray(n.type) && n.type.length > 1)) unions++;
    for (const [k, v] of Object.entries(n)) if (k !== 'enum' && k !== 'const') walk(v, `${path}.${k}`);
  };
  walk(schema, '$');
  if (optional > STRICT_LIMITS.optionalProperties) issues.push(`too many optional properties: ${optional} > ${STRICT_LIMITS.optionalProperties}`);
  if (unions > STRICT_LIMITS.unions) issues.push(`too many unions: ${unions} > ${STRICT_LIMITS.unions}`);
  return issues;
}
