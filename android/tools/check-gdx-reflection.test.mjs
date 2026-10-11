import assert from 'node:assert/strict';
import test from 'node:test';
import { assertReflectiveConstruction, reflectedClassNames, REFLECTED_GDX_CLASSES } from './check-gdx-reflection.mjs';

// Actual apkanalyzer output excerpt from the unshrunk APK. ReflectionPool calls
// Class.getConstructor() and newInstance(); a source-level keep rule is not proof.
const good = `.class public Lcom/badlogic/gdx/graphics/g2d/GlyphLayout$GlyphRun;
.super Ljava/lang/Object;
.source "GlyphLayout.java"

# interfaces
.implements Lcom/badlogic/gdx/utils/Pool$Poolable;

# direct methods
.method public constructor <init>()V
    .registers 2
    .line 527
    invoke-direct {p0}, Ljava/lang/Object;-><init>()V
    return-void
.end method
`;
const run = REFLECTED_GDX_CLASSES[1];

test('real DEX declaration retains what ReflectionPool needs to create font runs', () => {
  assert.doesNotThrow(() => assertReflectiveConstruction(good, run));
});

test('the delivered release crash fails even though R8 retained the class name', () => {
  // Actual broken release output: R8 abstracted the class and removed its ctor.
  assert.throws(() => assertReflectiveConstruction(`.class public abstract LA2/e;
.super Ljava/lang/Object;
.source "SourceFile"
# interfaces
.implements LO2/I;
`, 'A2.e'), /public concrete class/);
});

test('a retained concrete type with only an argument-taking constructor is unusable by the pool', () => {
  assert.throws(() => assertReflectiveConstruction(good.replace('<init>()V', '<init>(I)V'), run), /no-argument constructor/);
});

test('a constructor reference in another method cannot substitute for a constructor declaration', () => {
  const noCtor = good.replace('.method public constructor <init>()V', '.method public reset()V');
  assert.throws(() => assertReflectiveConstruction(noCtor, run), /no-argument constructor/);
});

test('private or package-private construction does not satisfy getConstructor()', () => {
  for (const access of ['private', 'protected', '']) {
    assert.throws(() => assertReflectiveConstruction(good.replace('public constructor', `${access} constructor`), run), /no-argument constructor/);
  }
});

test('missing or different DEX class output fails instead of certifying the mapped type', () => {
  assert.throws(() => assertReflectiveConstruction('', run), /missing/);
  assert.throws(() => assertReflectiveConstruction(good, 'another.Class'), /missing/);
});

test('both pooled font types are located by their compiled names, including unchanged keep names', () => {
  const mapping = `# compiler: R8\n${REFLECTED_GDX_CLASSES[0]} -> A2.f:\n    void reset() -> a\n${run} -> ${run}:\n`;
  assert.deepEqual(reflectedClassNames(mapping), [
    { original: REFLECTED_GDX_CLASSES[0], compiled: 'A2.f' },
    { original: run, compiled: run },
  ]);
});

test('a missing or ambiguous pooled class mapping cannot silently leave a type unchecked', () => {
  const mapping = REFLECTED_GDX_CLASSES.map((name) => `${name} -> ${name}:`).join('\n');
  assert.throws(() => reflectedClassNames(`${REFLECTED_GDX_CLASSES[0]} -> A2.f:`), /one R8 class mapping/);
  assert.throws(() => reflectedClassNames(`${mapping}\n${run} -> A2.e:`), /one R8 class mapping/);
});
