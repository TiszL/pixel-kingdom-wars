// Collect emitted names, never execute a simulator branch to discover its vocabulary.
// A conditional has two valid outputs even when a particular fixture takes only one.
export function emittedHeroVocabulary(ts, text) {
  const ast = ts.createSourceFile('sim.ts', text, ts.ScriptTarget.Latest, true);
  const skills = new Set(), phases = new Set();
  const name = (node) => ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;
  const values = (node, field) => {
    if (node && ts.isStringLiteral(node)) return [node.text];
    if (node && ts.isParenthesizedExpression(node)) return values(node.expression, field);
    if (node && ts.isConditionalExpression(node)) return [...values(node.whenTrue, field), ...values(node.whenFalse, field)];
    throw new Error(`Unsupported emitted hero ${field}: ${node?.getText(ast) ?? 'missing'}`);
  };
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const properties = node.properties.filter(ts.isPropertyAssignment);
      const event = properties.find((p) => name(p.name) === 'e')?.initializer;
      if (event && ts.isStringLiteral(event) && event.text === 'heroSkill') {
        for (const [field, target] of [['skill', skills], ['phase', phases]]) {
          const matches = properties.filter((p) => name(p.name) === field);
          if (matches.length !== 1) throw new Error(`Expected one emitted hero ${field}`);
          for (const value of values(matches[0].initializer, field)) target.add(value);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return { skills: [...skills].sort(), phases: [...phases].sort() };
}
