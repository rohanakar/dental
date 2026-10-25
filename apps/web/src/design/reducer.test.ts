import type { Command, Crown, InsertionAxis, MarginLine, Pose, ScanRef, ToothFrame } from '@dcad/shared';
import { MATERIAL_PRESETS } from '@dcad/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { activeAdapt, adaptationStale, readaptCommands } from './adaptation';
import { newDocument } from './document';
import { applyCommand, applyCommands, CommandError } from './reducer';
import { useDesignStore } from './store';

const sha = (c: string) => c.repeat(64);
const scan = (role: ScanRef['role'], hash = 'a'): ScanRef => ({
  role,
  name: `${role}.stl`,
  mesh: { sha256: sha(hash), units: 'mm', frame: 'scan' },
});
const frame: ToothFrame = {
  origin: [0, 0, 0],
  occlusal: [0, 0, 1],
  mesial: [0, 1, 0],
  buccal: [1, 0, 0],
  source: 'auto',
};
const margin: MarginLine = {
  anchors: [{ p: [1, 0, 0] }, { p: [0, 1, 0] }, { p: [-1, 0, 0] }],
  points: [{ p: [1, 0, 0] }, { p: [0, 1, 0] }, { p: [-1, 0, 0] }],
  source: 'manual',
};
const axis: InsertionAxis = { direction: [0, 0, 1], source: 'auto' };

describe('applyCommand', () => {
  it('replaces scans by role and invalidates the frame when a jaw scan changes', () => {
    let doc = applyCommands(newDocument(), [
      { type: 'addScan', scan: scan('lower') },
      { type: 'setFrame', fdi: 36, frame },
      { type: 'setMargin', fdi: 36, margin },
    ]);
    const same = applyCommand(doc, { type: 'addScan', scan: { ...scan('lower'), name: 'renamed.stl' } });
    expect(same.teeth[0]!.steps.frame).toBe('done');
    doc = applyCommand(doc, { type: 'addScan', scan: scan('lower', 'b') });
    expect(doc.scans).toHaveLength(1);
    expect(doc.teeth[0]!.steps.frame).toBe('stale');
    expect(doc.teeth[0]!.steps.margin).toBe('stale');
    expect(doc.teeth[0]!.steps.axis).toBe('pending');
  });

  it('marks downstream steps stale, but leaves pending ones alone', () => {
    let doc = applyCommands(newDocument(), [
      { type: 'setFrame', fdi: 36, frame },
      { type: 'setMargin', fdi: 36, margin },
      { type: 'setAxis', fdi: 36, axis },
    ]);
    expect(doc.teeth[0]!.steps).toMatchObject({ frame: 'done', margin: 'done', axis: 'done', proposal: 'pending' });
    doc = applyCommand(doc, { type: 'setMargin', fdi: 36, margin: { ...margin, source: 'agent' } });
    expect(doc.teeth[0]!.steps).toMatchObject({ frame: 'done', margin: 'done', axis: 'stale', proposal: 'pending' });
  });

  it('syncs teeth with the setup and resets params on a material change', () => {
    let doc = applyCommand(newDocument(), { type: 'setFrame', fdi: 36, frame });
    const before = doc.teeth[0]!;
    doc = applyCommand(doc, {
      type: 'setCaseSetup',
      setup: {
        patientRef: 'P-1',
        notes: '',
        connections: [],
        teeth: [
          { fdi: 36, restoration: 'anatomic-crown', material: 'zirconia' },
          { fdi: 46, restoration: 'anatomic-crown', material: 'lithium-disilicate' },
        ],
      },
    });
    expect(doc.teeth.map((t) => t.fdi)).toEqual([36, 46]);
    expect(doc.teeth[0]).toBe(before); // unchanged tooth keeps its identity
    expect(doc.teeth[1]!.params).toEqual(MATERIAL_PRESETS['lithium-disilicate']);
    doc = applyCommand(doc, {
      type: 'setCaseSetup',
      setup: { patientRef: 'P-1', notes: '', connections: [], teeth: [{ fdi: 36, restoration: 'anatomic-crown', material: 'pmma' }] },
    });
    expect(doc.teeth.map((t) => t.fdi)).toEqual([36]);
    expect(doc.teeth[0]!.params).toEqual(MATERIAL_PRESETS.pmma);
    expect(doc.teeth[0]!.frame).toEqual(frame);
  });

  it('bridge: derives units, keeps one common axis, invalidates across units', () => {
    // 36 starts as a single crown with a margin and axis, then becomes the pontic of 35–[36]–37.
    let doc = applyCommands(newDocument(), [
      { type: 'setFrame', fdi: 36, frame },
      { type: 'setMargin', fdi: 36, margin },
      { type: 'setAxis', fdi: 36, axis },
    ]);
    const order = (fdi: number, restoration: 'anatomic-crown' | 'pontic') => ({ fdi, restoration, material: 'zirconia' as const });
    const teeth = [order(35, 'anatomic-crown'), order(36, 'pontic'), order(37, 'anatomic-crown')];
    doc = applyCommand(doc, { type: 'setCaseSetup', setup: { patientRef: '', notes: '', teeth, connections: [[37, 36], [35, 36]] } });
    const offsets = { buccalMm: 0, occlusalMm: 0 };
    expect(doc.bridges).toEqual([
      { teeth: [35, 36, 37], connectors: [{ between: [35, 36], areaMm2: 9, ...offsets }, { between: [36, 37], areaMm2: 9, ...offsets }] },
    ]);
    const tooth = (fdi: number) => doc.teeth.find((t) => t.fdi === fdi)!;
    expect(tooth(36)).not.toHaveProperty('margin');
    expect(tooth(36)).not.toHaveProperty('axis');
    expect(tooth(36).steps).toMatchObject({ margin: 'pending', axis: 'pending' });
    expect(() => applyCommand(doc, { type: 'setAxis', fdi: 36, axis })).toThrow(CommandError);

    // One common axis: setAxis on 35 sets 37 too.
    doc = applyCommands(doc, [
      ...[35, 37].flatMap((fdi): Command[] => [
        { type: 'setFrame', fdi, frame },
        { type: 'setMargin', fdi, margin },
      ]),
      { type: 'setFrame', fdi: 36, frame },
    ]);
    const tilted: InsertionAxis = { direction: [0, 0.1, 0.995], source: 'auto' };
    doc = applyCommand(doc, { type: 'setAxis', fdi: 35, axis: tilted });
    expect(tooth(37).axis).toEqual(tilted);
    expect([tooth(35).steps.axis, tooth(37).steps.axis]).toEqual(['done', 'done']);

    // A new margin on 37 invalidates the common axis on 35; a new abutment frame also invalidates the pontic frame.
    doc = applyCommand(doc, { type: 'setMargin', fdi: 37, margin: { ...margin, source: 'agent' } });
    expect(tooth(35).steps.axis).toBe('stale');
    expect(tooth(36).steps.frame).toBe('done');
    doc = applyCommand(doc, { type: 'setFrame', fdi: 35, frame });
    expect(tooth(36).steps.frame).toBe('stale');

    // A connected side has a connector, not a contact; a connector never goes below the material minimum.
    doc = applyCommand(doc, { type: 'setCrown', fdi: 35, crown });
    expect(() => applyCommand(doc, { type: 'setContact', fdi: 35, side: 'distal', targetMm: 0 })).toThrow(CommandError);
    expect(applyCommand(doc, { type: 'setContact', fdi: 35, side: 'mesial', targetMm: 0 }).teeth[0]!.steps.adapt).toBe('done');
    expect(() => applyCommand(doc, { type: 'setConnector', between: [36, 35], areaMm2: 8 })).toThrow(CommandError);
    doc = applyCommand(doc, { type: 'setConnector', between: [36, 35], areaMm2: 12 });
    expect(doc.bridges[0]!.connectors[0]).toEqual({ between: [35, 36], areaMm2: 12, ...offsets });

    // Removing a bridged tooth drops its connections (35–[36] remains, a cantilever, with its connector settings);
    // the remaining abutment's common axis was searched with 37 and becomes stale.
    doc = applyCommand(doc, { type: 'setAxis', fdi: 35, axis: tilted });
    doc = applyCommand(doc, { type: 'setCaseSetup', setup: { ...doc.setup, teeth: doc.setup.teeth.filter((t) => t.fdi !== 37) } });
    expect(doc.bridges).toEqual([{ teeth: [35, 36], connectors: [{ between: [35, 36], areaMm2: 12, ...offsets }] }]);
    expect(tooth(35).steps.axis).toBe('stale');
  });

  it('never mutates its input', () => {
    const doc = newDocument();
    const json = JSON.stringify(doc);
    applyCommands(doc, [
      { type: 'addScan', scan: scan('lower') },
      { type: 'setFrame', fdi: 36, frame },
    ]);
    expect(JSON.stringify(doc)).toBe(json);
  });
});

describe('design store', () => {
  beforeEach(() => useDesignStore.getState().load(newDocument(), 0));
  const s = useDesignStore.getState;

  it('undoes and redoes a batch as one step', () => {
    const batch: Command[] = [
      { type: 'addScan', scan: scan('lower') },
      { type: 'setFrame', fdi: 36, frame },
    ];
    s().dispatch(batch);
    s().dispatch({ type: 'setMargin', fdi: 36, margin });
    expect(s().past).toHaveLength(2);
    s().undo();
    expect(s().doc.teeth[0]!.margin).toBeUndefined();
    expect(s().doc.teeth[0]!.frame).toEqual(frame);
    s().undo();
    expect(s().doc.scans).toHaveLength(0);
    s().redo();
    s().redo();
    expect(s().doc.teeth[0]!.margin).toEqual(margin);
    expect(s().future).toHaveLength(0);
  });

  it('validates commands and tracks unsaved changes', () => {
    expect(() => s().dispatch({ type: 'setFrame', fdi: 19, frame } as Command)).toThrow();
    expect(s().doc).toBe(s().savedDoc);
    const doc = s().dispatch({ type: 'addScan', scan: scan('lower') });
    expect(s().doc).not.toBe(s().savedDoc);
    s().markSaved(1, doc);
    expect(s().version).toBe(1);
    expect(s().doc).toBe(s().savedDoc);
  });

  it('applies a transaction live, commits it as one undo entry and records the author', () => {
    s().dispatch({ type: 'addScan', scan: scan('lower') });
    s().beginTransaction({ label: 'auto-design', author: 'proposer' });
    s().dispatch({ type: 'setFrame', fdi: 36, frame });
    s().dispatch({ type: 'setMargin', fdi: 36, margin });
    expect(s().doc.teeth[0]!.margin).toEqual(margin);
    expect(s().past).toHaveLength(1);
    s().undo(); // blocked while open
    expect(s().doc.teeth[0]!.margin).toEqual(margin);
    expect(() => s().beginTransaction({ label: 'x', author: 'agent' })).toThrow();
    s().commitTransaction();
    expect(s().past).toHaveLength(2);
    expect(s().lastAuthor).toBe('proposer');
    s().undo();
    expect(s().doc.teeth[0]!.frame).toBeUndefined();
    expect(s().doc.scans).toHaveLength(1);
  });

  it('rolls a transaction back to the base document', () => {
    const before = s().doc;
    s().beginTransaction({ label: 'agent', author: 'agent' });
    s().dispatch({ type: 'setFrame', fdi: 36, frame });
    s().rollbackTransaction();
    expect(s().doc).toBe(before);
    expect(s().transaction).toBeNull();
    expect(s().past).toHaveLength(0);
    s().dispatch({ type: 'setFrame', fdi: 36, frame });
    expect(s().lastAuthor).toBe('user');
  });
});

// ---- clinical commands ------------------------------------------------------

/** Quadrant 3 (36): mesial = buccal × occlusal → right-handed (mesial × buccal = occlusal). */
const rightHanded: ToothFrame = { origin: [0, 0, 0], occlusal: [0, 0, 1], mesial: [0, 1, 0], buccal: [-1, 0, 0], source: 'auto' };
/** Quadrant 4 (46): left-handed (mesial × buccal = −occlusal). */
const leftHanded: ToothFrame = { origin: [0, 0, 0], occlusal: [0, 0, 1], mesial: [0, 1, 0], buccal: [1, 0, 0], source: 'auto' };
const startPose: Pose = { position: [10, 5, 1], quaternion: [0, 0, 0, 1], scale: [-1, 1, 1] };
const crown: Crown = { kind: 'template', templateId: 'synthetic.lower-molar@1', pose: startPose };

function docWithCrown(fdi: number, f: ToothFrame) {
  const setup = { patientRef: '', notes: '', connections: [], teeth: [{ fdi, restoration: 'anatomic-crown' as const, material: 'zirconia' as const }] };
  return applyCommands(newDocument('c', setup), [
    { type: 'setFrame', fdi, frame: f },
    { type: 'setCrown', fdi, crown },
  ]);
}
const poseOf = (doc: ReturnType<typeof newDocument>) => {
  const c = doc.teeth[0]!.crown!;
  if (c.kind !== 'template') throw new Error('expected a template crown');
  return c.pose;
};

describe.each([
  ['right-handed frame (36)', 36, rightHanded],
  ['left-handed frame (46)', 46, leftHanded],
] as const)('clinical commands, %s', (_name, fdi, f) => {
  it('moves, rotates and scales in frame directions', () => {
    const doc = docWithCrown(fdi, f);
    const mesial = poseOf(applyCommand(doc, { type: 'moveCrown', fdi, direction: 'mesial', mm: 0.5 }));
    expect(mesial.position).toEqual([10 + 0.5 * f.mesial[0], 5 + 0.5 * f.mesial[1], 1 + 0.5 * f.mesial[2]]);
    const lingual = poseOf(applyCommand(doc, { type: 'moveCrown', fdi, direction: 'lingual', mm: 0.3 }));
    expect(lingual.position[0]).toBeCloseTo(10 - 0.3 * f.buccal[0], 12);

    // Rotation is about the crown centre (above the cervical origin) and returns after 360° in 2° steps.
    expect(poseOf(applyCommand(doc, { type: 'rotateCrown', fdi, axis: 'mesial-distal', deg: 10 })).position).not.toEqual(startPose.position);
    let spun = doc;
    for (let i = 0; i < 180; i++) spun = applyCommand(spun, { type: 'rotateCrown', fdi, axis: 'buccal-lingual', deg: 2 });
    const back = poseOf(spun);
    back.position.forEach((x, i) => expect(x).toBeCloseTo(startPose.position[i]!, 6));
    const sign = Math.sign(back.quaternion[3]) || 1; // q and −q are the same rotation
    back.quaternion.forEach((x, i) => expect(sign * x).toBeCloseTo(startPose.quaternion[i]!, 6));

    // Scaling keeps the mirror sign.
    expect(poseOf(applyCommand(doc, { type: 'scaleCrown', fdi, axis: 'mesial-distal', pct: 10 })).scale).toEqual([-1.1, 1, 1]);
    expect(poseOf(applyCommand(doc, { type: 'scaleCrown', fdi, axis: 'occlusal', pct: -20 })).scale).toEqual([-1, 1, 0.8]);
  });
});

describe('adaptation commands', () => {
  it('keep their targets through a move but apply only while adapt is done; Re-adapt restores them in one undo entry', () => {
    let doc = docWithCrown(36, leftHanded);
    expect(activeAdapt(doc.teeth[0]!)).toBeUndefined();
    doc = applyCommands(doc, [
      { type: 'adaptOcclusion', fdi: 36, clearanceMm: 0.05 },
      { type: 'setContact', fdi: 36, side: 'distal', targetMm: -0.01 },
    ]);
    const targets = { occlusion: { clearanceMm: 0.05 }, distal: { targetMm: -0.01 } };
    expect(doc.teeth[0]!.steps.adapt).toBe('done');
    expect(activeAdapt(doc.teeth[0]!)).toEqual(targets);

    doc = applyCommand(doc, { type: 'moveCrown', fdi: 36, direction: 'occlusal', mm: 0.5 });
    const moved = doc.teeth[0]!;
    expect(moved.crown).toMatchObject({ adapt: targets });
    expect(activeAdapt(moved)).toBeUndefined();
    expect(adaptationStale(moved)).toBe(true);
    const cmds = readaptCommands(moved);
    expect(cmds).toEqual([
      { type: 'adaptOcclusion', fdi: 36, clearanceMm: 0.05 },
      { type: 'setContact', fdi: 36, side: 'distal', targetMm: -0.01 },
    ]);

    const s = useDesignStore.getState;
    s().load(doc, 0);
    s().dispatch(cmds);
    expect(s().past).toHaveLength(1);
    expect(activeAdapt(s().doc.teeth[0]!)).toEqual(targets);
    expect(poseOf(s().doc)).toEqual(poseOf(doc));
    expect(adaptationStale(s().doc.teeth[0]!)).toBe(false);
  });
});
