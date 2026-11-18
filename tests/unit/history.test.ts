import { describe, expect, it } from 'vitest';
import { History } from '../../src/engine/history';

function drain(history: History<string>, step: 'undo' | 'redo'): string[] {
  const visited: string[] = [];
  for (let state = history[step](); state !== undefined; state = history[step]()) visited.push(state);
  return visited;
}

describe('History', () => {
  it('starts with the initial state and nothing to undo or redo', () => {
    const history = new History('a');
    expect(history.present).toBe('a');
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });

  it('returns undefined at both ends without changing the present', () => {
    const history = new History('a');
    expect(history.undo()).toBeUndefined();
    expect(history.redo()).toBeUndefined();
    expect(history.present).toBe('a');
  });

  it('undoes and redoes pushed states in order', () => {
    const history = new History('a');
    history.push('b');
    history.push('c');
    expect(history.present).toBe('c');
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);

    expect(history.undo()).toBe('b');
    expect(history.undo()).toBe('a');
    expect(history.undo()).toBeUndefined();
    expect(history.present).toBe('a');
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);

    expect(history.redo()).toBe('b');
    expect(history.redo()).toBe('c');
    expect(history.redo()).toBeUndefined();
    expect(history.present).toBe('c');
  });

  it('discards the redo branch on push', () => {
    const history = new History('a');
    history.push('b');
    history.push('c');
    history.undo();
    history.push('d');
    expect(history.canRedo).toBe(false);
    expect(history.redo()).toBeUndefined();
    expect(drain(history, 'undo')).toEqual(['b', 'a']);
    expect(drain(history, 'redo')).toEqual(['b', 'd']);
  });

  it('records a push of the current state as its own step', () => {
    const history = new History('a');
    history.push('a');
    expect(history.canUndo).toBe(true);
    expect(history.undo()).toBe('a');
  });

  it('replace overwrites the present without adding a step', () => {
    const history = new History('a');
    history.push('b');
    history.replace('b2');
    expect(history.present).toBe('b2');
    expect(history.undo()).toBe('a');
    expect(history.undo()).toBeUndefined();
    expect(history.redo()).toBe('b2');
  });

  it('turns a push + replace gesture into one undo step', () => {
    const history = new History(0);
    history.push(1);
    for (let value = 2; value <= 10; value++) history.replace(value);
    expect(history.present).toBe(10);
    expect(history.undo()).toBe(0);
    expect(history.canUndo).toBe(false);
    expect(history.redo()).toBe(10);
  });

  it('keeps the pre-gesture state when the gesture starts by pushing the present', () => {
    const history = new History('a');
    history.push('a');
    history.replace('a2');
    expect(history.undo()).toBe('a');
  });

  it('replace with a different state clears redo; with the same state it keeps it', () => {
    const history = new History('a');
    history.push('b');
    history.undo();
    history.replace('a');
    expect(history.canRedo).toBe(true);
    history.replace('a2');
    expect(history.canRedo).toBe(false);
    expect(history.present).toBe('a2');
  });

  it('drops the oldest states beyond the limit', () => {
    const history = new History('s0', 3);
    for (let i = 1; i <= 6; i++) history.push(`s${i}`);
    expect(drain(history, 'undo')).toEqual(['s5', 's4', 's3']);
    expect(history.present).toBe('s3');
    expect(drain(history, 'redo')).toEqual(['s4', 's5', 's6']);
  });

  it('never exceeds the limit across undo/redo/push cycles', () => {
    const history = new History('s0', 2);
    history.push('s1');
    history.push('s2');
    history.undo();
    history.redo();
    history.push('s3');
    expect(drain(history, 'undo')).toEqual(['s2', 's1']);
  });

  it('keeps exactly one step with a limit of one', () => {
    const history = new History('a', 1);
    history.push('b');
    history.push('c');
    expect(history.undo()).toBe('b');
    expect(history.undo()).toBeUndefined();
    expect(history.redo()).toBe('c');
    expect(history.canRedo).toBe(false);
    expect(history.undo()).toBe('b');
  });

  it('replace without a prior push changes nothing but the present', () => {
    const history = new History('a');
    history.replace('a2');
    expect(history.present).toBe('a2');
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });

  it('supports a zero limit (no undo)', () => {
    const history = new History('a', 0);
    history.push('b');
    expect(history.present).toBe('b');
    expect(history.canUndo).toBe(false);
    expect(history.undo()).toBeUndefined();
  });

  it('rejects invalid limits', () => {
    for (const limit of [-1, 1.5, NaN, Infinity]) {
      expect(() => new History('a', limit)).toThrow(RangeError);
    }
  });

  it('reset forgets everything', () => {
    const history = new History('a');
    history.push('b');
    history.push('c');
    history.undo();
    history.reset('z');
    expect(history.present).toBe('z');
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    history.push('y');
    expect(drain(history, 'undo')).toEqual(['z']);
  });

  it('stores states by reference', () => {
    const first = { n: 1 };
    const second = { n: 2 };
    const history = new History(first);
    history.push(second);
    expect(history.undo()).toBe(first);
    expect(history.redo()).toBe(second);
  });
});
