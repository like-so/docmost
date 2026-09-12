import { BadRequestException } from '@nestjs/common';

export type FormulaValue = string | number | boolean | null;
type Token = FormulaValue | { property: string } | '+' | '-' | '*' | '/' | '&' | '(' | ')' | '=' | '!=' | '<' | '<=' | '>' | '>=' | 'DATE';

export function evaluateFormula(input: string, values: Record<string, unknown>, propertyIds: Map<string, string>): FormulaValue {
  const tokens = tokenize(input);
  let index = 0;
  const comparison = (): FormulaValue => {
    let value = concat();
    while (['=', '!=', '<', '<=', '>', '>='].includes(String(tokens[index]))) {
      const operator = String(tokens[index++]);
      const right = concat();
      value = compare(value, right, operator);
    }
    return value;
  };
  const concat = (): FormulaValue => {
    let value = sum();
    while (tokens[index] === '&') { index += 1; value = `${display(value)}${display(sum())}`; }
    return value;
  };
  const sum = (): FormulaValue => {
    let value = product();
    while (tokens[index] === '+' || tokens[index] === '-') {
      const operator = tokens[index++];
      const right = product();
      value = add(value, right, operator === '-');
    }
    return value;
  };
  const product = (): FormulaValue => {
    let value = factor();
    while (tokens[index] === '*' || tokens[index] === '/') {
      const operator = tokens[index++];
      const right = number(factor());
      if (operator === '/' && right === 0) throw new BadRequestException('Formula division by zero');
      value = operator === '*' ? number(value) * right : number(value) / right;
    }
    return value;
  };
  const factor = (): FormulaValue => {
    const token = tokens[index++];
    if (token === '-') return -number(factor());
    if (token === '(') { const value = comparison(); if (tokens[index++] !== ')') throw malformed(); return value; }
    if (token === 'DATE') { if (tokens[index++] !== '(') throw malformed(); const value = factor(); if (tokens[index++] !== ')') throw malformed(); return date(display(value)); }
    if (token && typeof token === 'object') return scalar(values[propertyIds.get(token.property) ?? '']);
    if (typeof token === 'number') return token;
    if (typeof token === 'boolean') return token;
    if (typeof token === 'string' && !['+', '-', '*', '/', '&', '(', ')', '=', '!=', '<', '<=', '>', '>=', 'DATE'].includes(token)) return token;
    throw malformed();
  };
  const value = comparison();
  if (index !== tokens.length || (typeof value === 'number' && !Number.isFinite(value))) throw malformed();
  return value;
}

function scalar(value: unknown): FormulaValue { return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null; }
function add(left: FormulaValue, right: FormulaValue, subtract: boolean): FormulaValue {
  if (isDate(left) && typeof right === 'number') { const value = new Date(`${left}T00:00:00.000Z`); value.setUTCDate(value.getUTCDate() + (subtract ? -right : right)); return value.toISOString().slice(0, 10); }
  return number(left) + (subtract ? -number(right) : number(right));
}
function compare(left: FormulaValue, right: FormulaValue, operator: string): boolean {
  const [first, second] = typeof left === 'number' && typeof right === 'number' ? [left, right] : [display(left), display(right)];
  return operator === '=' ? first === second : operator === '!=' ? first !== second : operator === '<' ? first < second : operator === '<=' ? first <= second : operator === '>' ? first > second : first >= second;
}
function number(value: FormulaValue): number { const result = typeof value === 'number' ? value : Number(value ?? 0); if (!Number.isFinite(result)) throw malformed(); return result; }
function display(value: FormulaValue): string { return value === null ? '' : String(value); }
function date(value: string): string { if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00.000Z`).valueOf())) throw malformed(); return value; }
function isDate(value: FormulaValue): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value); }
function malformed(): BadRequestException { return new BadRequestException('Malformed formula'); }

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  for (let index = 0; index < input.length;) {
    const rest = input.slice(index);
    const char = input[index];
    if (/\s/.test(char)) { index += 1; continue; }
    const operator = rest.match(/^(<=|>=|!=|[+\-*/&()=<>])/);
    if (operator) { tokens.push(operator[0] as Token); index += operator[0].length; continue; }
    if (char === '{') { const end = input.indexOf('}', index + 1); const property = input.slice(index + 1, end).trim(); if (end < 0 || !property) throw malformed(); tokens.push({ property }); index = end + 1; continue; }
    if (char === '"') { let value = ''; index += 1; while (index < input.length && input[index] !== '"') { value += input[index++]; } if (input[index] !== '"') throw malformed(); tokens.push(value); index += 1; continue; }
    const numberToken = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if (numberToken) { tokens.push(Number(numberToken[0])); index += numberToken[0].length; continue; }
    const word = rest.match(/^[A-Za-z]+/);
    if (!word) throw malformed();
    const value = word[0].toUpperCase();
    if (value === 'TRUE') tokens.push(true); else if (value === 'FALSE') tokens.push(false); else if (value === 'DATE') tokens.push('DATE'); else throw malformed();
    index += word[0].length;
  }
  if (!tokens.length || input.length > 2000) throw malformed();
  return tokens;
}
