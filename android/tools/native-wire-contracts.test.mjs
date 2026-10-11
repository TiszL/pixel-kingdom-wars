import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('exported native schemas preserve canonical presentation, purchase and cancellation receipts with concrete Kotlin variants', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = path.resolve(process.env.PKW_NATIVE_SCHEMA_TEST_SOURCE ?? process.env.PKW_NATIVE_SOURCE ?? path.join(root, '.source'));
  const result = spawnSync(process.execPath, ['--import', path.join(source, 'scripts/node_modules/tsx/dist/loader.mjs'), '--input-type=module'], {
    encoding: 'utf8', env: { ...process.env, PKW_TEST_SOURCE: source, PKW_TEST_ROOT: pathToFileURL(root + '/').href }, input: `
      import assert from 'node:assert/strict';
      import {createRequire} from 'node:module';
      import {pathToFileURL} from 'node:url';
      const source = process.env.PKW_TEST_SOURCE;
      const {nativeWireContracts, nativeSchemaNames, nativeEndpoints} = await import(process.env.PKW_TEST_ROOT + 'tools/native-wire-contracts.mjs');
      const {kotlinModels} = await import(process.env.PKW_TEST_ROOT + 'tools/wire-contracts.mjs');
      const canonical = await import(pathToFileURL(source + '/apps/api/src/native/contracts.ts'));
      const recovery = await import(pathToFileURL(source + '/apps/api/src/game/trainingRecovery.ts'));
      const construction = await import(pathToFileURL(source + '/apps/api/src/game/constructionReceipt.ts'));
      const cancellation = await import(pathToFileURL(source + '/apps/api/src/game/trainingCancellationReceipt.ts'));
      const schedule = await import(pathToFileURL(source + '/apps/api/src/game/trainingSchedule.ts'));
      const research = await import(pathToFileURL(source + '/apps/api/src/game/researchConsent.ts'));
      const heroConsent = await import(pathToFileURL(source + '/apps/api/src/game/heroConsent.ts'));
      const heroReceipt = await import(pathToFileURL(source + '/apps/api/src/game/heroReceipt.ts'));
      const {LIVE_RAID, RAID_REPLAY_LIMITS} = await import(pathToFileURL(source + '/packages/shared/src/constants.ts'));
      const require = createRequire(source + '/apps/api/package.json');
      const fastifyRequire = createRequire(require.resolve('fastify'));
      const compilerRequire = createRequire(fastifyRequire.resolve('@fastify/ajv-compiler'));
      const Ajv = compilerRequire('ajv/dist/2020.js').default;
      const schemas = await nativeWireContracts(source);
      const ajv = new Ajv({strict:false, validateFormats:false});
      ajv.addSchema({schemas}, 'pack');
      for (const name of nativeSchemaNames) assert.ok(ajv.getSchema('pack#/schemas/' + name));
      const schema = schemas.NativePresentationPage;
      assert.equal(schema.properties.totalCommands.maximum, LIVE_RAID.maxCommands);
      assert.equal(schema.properties.totalEvents.maximum, RAID_REPLAY_LIMITS.maxEvents);
      const validate = ajv.getSchema('pack#/schemas/NativePresentationPage');
      const decimal = '18446744073709551615';
      const page = {protocolVersion:2, raidId:'11111111-1111-4111-8111-111111111111', revision:'a'.repeat(64),
        parentRevision:null, replaceFromTick:0, generation:'b'.repeat(32), eventOffset:0, totalEvents:1,
        commandOffset:0, totalCommands:1, commands:[{sequence:0, clientCommandId:' ', kind:'deploy',
          payload:{amount:decimal, arbitrary:{nested:[null,true,1.25]}},serverOffsetMs:0,acceptedAt:'2026-09-01T00:00:00.000Z'}],
        events:[{t:0,e:'pos',futureField:{amount:decimal}}],nextCursor:null,state:null, futureEnvelope:true};
      for(const fixture of [page, {...page,state:undefined}, {...page,nextCursor:undefined}, {...page,totalCommands:'1'},
          {...page,totalCommands:LIVE_RAID.maxCommands+1}, {...page,commands:[{...page.commands[0],payload:{amount:decimal}}]}]) {
        const wire=JSON.parse(JSON.stringify(fixture));
        assert.equal(validate(wire), canonical.NativePresentationPageSchema.safeParse(wire).success, JSON.stringify(validate.errors));
      }
      assert.ok(validate(page));
      assert.equal(canonical.NativePresentationPageSchema.parse(page).commands[0].payload.amount,decimal);
      assert.deepEqual(canonical.NativePresentationPageSchema.parse(page).events[0].futureField,{amount:decimal});
      const key='receipt-abcdefgh';
      const troop=recovery.TrainingRecoverySchema.options.find(option=>option.shape.status.value==='accepted').shape.request.shape.composition.element.shape.troop.options[0];
      const accepted={version:1,status:'accepted',idempotencyKey:key,baseId:null,acceptedAt:'2026-09-01T00:00:00.000Z',
        request:{composition:[{troop,count:1}],confirmedCostShards:decimal},
        result:{queue:[{id:page.raidId,troop,finishesAt:'2026-09-01T00:00:00.000Z'}],costShards:decimal,replayed:true}};
      // Troop membership, query limits and all result constraints come from Zod.
      const validateRecovery=ajv.getSchema('pack#/schemas/TrainingRecovery');
      for(const fixture of [{version:1,status:'unknown',idempotencyKey:key},
          {version:1,status:'closed',idempotencyKey:key,closedAt:'2026-09-01T00:00:00.000Z'},accepted,
          {...accepted,futureEnvelope:true,request:{...accepted.request,futureRequest:{decimal}},
            result:{...accepted.result,futureResult:[null,decimal]}}]) {
        assert.ok(recovery.TrainingRecoverySchema.safeParse(fixture).success);
        assert.ok(validateRecovery(fixture),JSON.stringify(validateRecovery.errors));
      }
      for(const fixture of [{...accepted,baseId:undefined}, {...accepted,status:'future'}, {...accepted,version:2},
          {...accepted,request:{...accepted.request,confirmedCostShards:1}},
          {...accepted,result:{...accepted.result,replayed:false}}]) {
        const wire=JSON.parse(JSON.stringify(fixture));
        assert.equal(recovery.TrainingRecoverySchema.safeParse(wire).success,false);
        assert.equal(validateRecovery(wire),false);
      }
      for(const [name,fixtures] of [
          ['TrainingReceiptQuery',[{idempotencyKey:key},{idempotencyKey:''},{idempotencyKey:key,baseId:page.raidId}]],
          ['TrainingCloseBody',[{idempotencyKey:key,confirmed:true},{idempotencyKey:key},{idempotencyKey:key,confirmed:false},{idempotencyKey:key,confirmed:true,baseId:page.raidId}]]]) {
        const check=ajv.getSchema('pack#/schemas/'+name);
        for(const fixture of fixtures) assert.equal(check(fixture),recovery[name+'Schema'].safeParse(fixture).success);
      }
      assert.deepEqual(nativeEndpoints.find(value=>value.path==='/army/training/receipt'),
        {method:'GET',path:'/army/training/receipt',query:'TrainingReceiptQuery',response:'TrainingRecovery'});
      assert.deepEqual(nativeEndpoints.find(value=>value.path==='/army/training/close'),
        {method:'POST',path:'/army/training/close',body:'TrainingCloseBody',response:'TrainingRecovery'});
      const kotlin=kotlinModels('source',schemas);
      assert.match(kotlin,/val clock: NativeClockDto\\?,/);
      assert.match(kotlin,/val state: NativePresentationStateDto\\?,/);
      assert.doesNotMatch(kotlin,/val (clock|state|nextCursor): [^\\n]* = null/);
      assert.match(kotlin,/val commands: List<NativeCommandDto>,/);
      assert.match(kotlin,/val events: List<JsonElement>,/);
      assert.match(kotlin,/val payload: JsonElement,/);
      assert.match(kotlin,/val serverOffsetMs: Long,/);
      for(const option of recovery.TrainingRecoverySchema.options) {
        const status=option.shape.status.value;
        const name='TrainingRecovery'+status[0].toUpperCase()+status.slice(1);
        assert.ok(schemas[name]);
        assert.ok(kotlin.includes('data class '+name+'Dto('));
      }
      assert.ok(kotlin.includes('val request: TrainingRecoveryAcceptedRequestDto,'));
      assert.ok(kotlin.includes('val result: TrainingRecoveryAcceptedResultDto,'));
      assert.ok(kotlin.includes('val composition: List<TrainingRecoveryAcceptedRequestCompositionItemDto>,'));
      assert.ok(kotlin.includes('val queue: List<TrainingRecoveryAcceptedResultQueueItemDto>,'));
      assert.ok(kotlin.includes('val baseId: String?,'));
      assert.ok(kotlin.includes('val confirmedCostShards: String,'));
      assert.ok(kotlin.includes('val confirmed: Boolean,'));
      const placement={version:1,status:'accepted',request:{idempotencyKey:key,type:'cannon',tx:8,ty:9,baseId:page.raidId},
        baseId:page.raidId,receiptId:page.raidId,acceptedAt:'2026-09-01T00:00:00.000Z',funding:{currency:'SHARDS',amount:decimal}};
      const validatePlacement=ajv.getSchema('pack#/schemas/ConstructionReceipt');
      for(const fixture of [placement,{version:1,status:'unknown',idempotencyKey:key},
          {...placement,futureEnvelope:{decimal}}, {...placement,baseId:undefined},
          {...placement,funding:{currency:'SHARDS',amount:1}}, {...placement,funding:{currency:'SHARDS',amount:'0'}},
          {...placement,request:{...placement.request,tx:1.5}}, {...placement,version:2},
          {...placement,request:{...placement.request,futureRequest:true}}]) {
        const wire=JSON.parse(JSON.stringify(fixture));
        assert.equal(validatePlacement(wire),construction.ConstructionReceiptSchema.safeParse(wire).success,JSON.stringify(validatePlacement.errors));
      }
      assert.ok(validatePlacement(placement));
      assert.ok(kotlin.includes('data class ConstructionReceiptAcceptedDto('));
      assert.ok(kotlin.includes('val request: ConstructionReceiptAcceptedRequestDto,'));
      assert.ok(kotlin.includes('val funding: ConstructionReceiptAcceptedFundingDto,'));
      assert.ok(kotlin.includes('val amount: String,'));
      assert.deepEqual(nativeEndpoints.find(endpoint=>endpoint.path==='/base/buildings/receipt'),
        {method:'GET',path:'/base/buildings/receipt',response:'ConstructionReceipt'});
      // Cancellation reads prove a refund from the original server receipt,
      // independently of the purchase recovery union or today's selected deed.
      const cancelBody={idempotencyKey:key,baseId:page.raidId};
      const cancelResult={id:page.raidId,troop,refundShards:decimal,cancelledAt:'2026-09-01T00:00:00.000Z',replayed:false};
      const cancelUnknown={version:1,status:'unknown',queueId:page.raidId,idempotencyKey:key,baseId:null};
      const cancelAccepted={...cancelUnknown,status:'accepted',baseId:page.raidId,result:{...cancelResult,replayed:true}};
      const checkCancellation=(name,fixture,expected)=>{
        const wire=JSON.parse(JSON.stringify(fixture));
        const canonical=cancellation[name+'Schema'];
        const exported=ajv.getSchema('pack#/schemas/'+name);
        assert.equal(canonical.safeParse(wire).success,expected,name+' canonical '+JSON.stringify(wire));
        assert.equal(exported(wire),expected,name+' exported '+JSON.stringify(exported.errors));
      };
      checkCancellation('TrainingCancellationPath',{queueId:page.raidId},true);
      checkCancellation('TrainingCancellationPath',{},false);
      for(const name of ['TrainingCancellationBody','TrainingCancellationReceiptQuery']) {
        for(const fixture of [cancelBody,{idempotencyKey:key}]) checkCancellation(name,fixture,true);
        for(const fixture of [{...cancelBody,baseId:null},{baseId:page.raidId},{...cancelBody,idempotencyKey:''}])
          checkCancellation(name,fixture,false);
      }
      checkCancellation('TrainingCancellationBody',{...cancelBody,futureRequest:true},true);
      checkCancellation('TrainingCancellationReceiptQuery',{...cancelBody,futureRequest:true},false);
      assert.deepEqual(cancellation.TrainingCancellationBodySchema.parse({...cancelBody,futureRequest:true}),cancelBody);
      for(const fixture of [cancelResult,{...cancelResult,replayed:true},{...cancelResult,futureResult:{decimal}}])
        checkCancellation('TrainingCancellationResult',fixture,true);
      for(const refundShards of [1,0,'0','-1','01','1'.repeat(33)]) {
        checkCancellation('TrainingCancellationResult',{...cancelResult,refundShards},false);
        checkCancellation('TrainingCancellationReceipt',{...cancelAccepted,result:{...cancelAccepted.result,refundShards}},false);
      }
      checkCancellation('TrainingCancellationResult',{...cancelResult,refundShards:'1'.repeat(32)},true);
      assert.equal(cancellation.TrainingCancellationResultSchema.parse(cancelResult).refundShards,decimal);
      for(const fixture of [cancelUnknown,{...cancelUnknown,baseId:page.raidId},cancelAccepted,
          {...cancelAccepted,baseId:null}, {...cancelAccepted,futureEnvelope:{decimal},result:{...cancelAccepted.result,futureResult:true}}])
        checkCancellation('TrainingCancellationReceipt',fixture,true);
      for(const fixture of [{...cancelUnknown,baseId:undefined},{...cancelAccepted,baseId:undefined},
          {...cancelAccepted,result:undefined},{...cancelAccepted,result:null},{...cancelAccepted,queueId:undefined},
          {...cancelAccepted,result:cancelResult},{...cancelAccepted,result:{...cancelAccepted.result,replayed:undefined}},
          {...cancelAccepted,status:'closed'},{...cancelAccepted,version:2}])
        checkCancellation('TrainingCancellationReceipt',fixture,false);
      const cancellationEndpoints=[
        {method:'POST',path:'/army/train/:queueId/cancel',params:'TrainingCancellationPath',body:'TrainingCancellationBody',response:'TrainingCancellationResult'},
        {method:'GET',path:'/army/train/:queueId/cancel/receipt',params:'TrainingCancellationPath',query:'TrainingCancellationReceiptQuery',response:'TrainingCancellationReceipt'}];
      for(const expected of cancellationEndpoints)
        assert.deepEqual(nativeEndpoints.filter(endpoint=>endpoint.path===expected.path),[expected]);
      for(const name of ['TrainingCancellationPath','TrainingCancellationBody','TrainingCancellationResult',
          'TrainingCancellationReceiptQuery','TrainingCancellationReceipt'])
        assert.equal(nativeSchemaNames.filter(candidate=>candidate===name).length,1);
      const kotlinClass=(name)=>{
        const declaration='data class '+name+'Dto(';
        assert.ok(kotlin.includes(declaration),declaration);
        return kotlin.split(declaration)[1].split(')')[0];
      };
      for(const name of ['TrainingCancellationBody','TrainingCancellationReceiptQuery'])
        assert.ok(kotlinClass(name).includes('val baseId: String? = null,'));
      for(const option of cancellation.TrainingCancellationReceiptSchema.options) {
        const status=option.shape.status.value;
        const name='TrainingCancellationReceipt'+status[0].toUpperCase()+status.slice(1);
        assert.ok(schemas[name]);
        const declaration=kotlinClass(name);
        assert.ok(declaration.includes('val queueId: String,'));
        assert.ok(declaration.includes('val idempotencyKey: String,'));
        assert.ok(declaration.includes('val baseId: String?,'));
        assert.ok(!declaration.includes('val baseId: String? = null,'));
      }
      assert.ok(kotlinClass('TrainingCancellationReceiptAccepted').includes('val result: TrainingCancellationReceiptAcceptedResultDto,'));
      // Training schedule v2 consents (D-114) and research consents are the exact
      // server snapshots a mutation must echo; exported schemas must agree with Zod.
      const row={id:page.raidId,startedAt:'2026-09-01T00:00:00.000Z',finishesAt:'2026-09-01T00:00:10.000Z'};
      const scheduleConsent={version:2,queue:[row],unitDurations:[{troop,durationMs:1000}]};
      const finishConsent={version:2,queue:[row],maxCostKeep:'12'};
      const checkConsent=(name,module,fixture,expected)=>{
        const wire=JSON.parse(JSON.stringify(fixture));
        assert.equal(module[name+'Schema'].safeParse(wire).success,expected,name+' canonical '+JSON.stringify(wire));
        assert.equal(ajv.getSchema('pack#/schemas/'+name)(wire),expected,name+' exported '+JSON.stringify(ajv.getSchema('pack#/schemas/'+name).errors));
      };
      checkConsent('TrainingScheduleConsent',schedule,scheduleConsent,true);
      checkConsent('TrainingScheduleConsent',schedule,{...scheduleConsent,version:1},false);
      checkConsent('TrainingScheduleConsent',schedule,{...scheduleConsent,extra:true},false);
      checkConsent('TrainingScheduleConsent',schedule,{...scheduleConsent,queue:[{...row,extra:1}]},false);
      checkConsent('TrainingFinishAllConsent',schedule,finishConsent,true);
      for(const maxCostKeep of [12,'01','-1','']) checkConsent('TrainingFinishAllConsent',schedule,{...finishConsent,maxCostKeep},false);
      assert.ok(schemas.TrainingQueueConsentRow,'shared queue row registered once under its shared type name');
      const consentClass=kotlinClass('TrainingScheduleConsent');
      assert.ok(consentClass.includes('val version: Int,'));
      assert.ok(consentClass.includes('val queue: List<TrainingQueueConsentRowDto>,'));
      assert.ok(consentClass.includes('val unitDurations: List<TrainingScheduleConsentUnitDurationsItemDto>,'));
      assert.ok(kotlinClass('TrainingFinishAllConsent').includes('val queue: List<TrainingQueueConsentRowDto>,'));
      assert.ok(kotlinClass('TrainingFinishAllConsent').includes('val maxCostKeep: String,'));
      for(const field of ['id','startedAt','finishesAt']) assert.ok(kotlinClass('TrainingQueueConsentRow').includes('val '+field+': String,'));
      const episode={currentLevel:1,toLevel:2,finishesAt:'2026-09-01T00:00:00.000+00:00',episodeId:null};
      checkConsent('ResearchStartConsent',research,{currentLevel:1,maxCostShards:'5'},true);
      checkConsent('ResearchStartConsent',research,{currentLevel:0,maxCostShards:'5'},false);
      checkConsent('ResearchEpisodeConsent',research,episode,true);
      checkConsent('ResearchEpisodeConsent',research,{...episode,episodeId:page.raidId},true);
      checkConsent('ResearchFinishConsent',research,{...episode,maxCostKeep:'3'},true);
      checkConsent('ResearchFinishConsent',research,episode,false);
      assert.ok(kotlinClass('ResearchFinishConsent').includes('val episodeId: String?,'));
      assert.ok(kotlinClass('ResearchFinishConsent').includes('val maxCostKeep: String,'));
      assert.ok(!kotlinClass('ResearchEpisodeConsent').includes('maxCostKeep'));
      // Hero confirmation and recovery must preserve an exact level/injury and
      // wide KEEP ceiling; mutable roster state can never replace a receipt.
      const heroUpgrade={expectedLevel:1,maxCostKeep:decimal};
      const heroRecovery={recoveryUntil:'2026-09-01T00:00:00.000Z',maxCostKeep:decimal};
      for(const [name,fixture] of [['HeroUpgradeConsent',heroUpgrade],['HeroRecoveryConsent',heroRecovery]]) {
        checkConsent(name,heroConsent,fixture,true);
        for(const maxCostKeep of [1,'01','-1','1'.repeat(33)]) checkConsent(name,heroConsent,{...fixture,maxCostKeep},false);
        checkConsent(name,heroConsent,{...fixture,extra:true},false);
        assert.ok(kotlinClass(name).includes('val maxCostKeep: String,'));
      }
      for(const [name,request,result] of [
          ['HeroUpgradeReceipt',heroUpgrade,{fromLevel:1,toLevel:2}],
          ['HeroRecoveryReceipt',heroRecovery,{recoveryUntil:heroRecovery.recoveryUntil}]]) {
        const receipt={version:1,status:'accepted',wallet:'viewer',baseId:page.raidId,receiptId:page.raidId,
          acceptedAt:'2026-09-01T00:00:00.000Z',request:{idempotencyKey:key,baseId:page.raidId,hero:'vex',...request},
          funding:{currency:'KEEP',amount:decimal},result};
        checkConsent(name,heroReceipt,receipt,true);
        checkConsent(name,heroReceipt,{version:1,status:'unknown',idempotencyKey:key},true);
        checkConsent(name,heroReceipt,{...receipt,request:{...receipt.request,maxCostKeep:1}},false);
        checkConsent(name,heroReceipt,{...receipt,funding:{currency:'KEEP',amount:'0'}},false);
        checkConsent(name,heroReceipt,{...receipt,baseId:undefined},false);
        assert.ok(kotlinClass(name+'Accepted').includes('val request: '+name+'AcceptedRequestDto,'));
        assert.ok(kotlinClass(name+'AcceptedRequest').includes('val maxCostKeep: String,'));
      }
      assert.deepEqual(nativeEndpoints.find(value=>value.path==='/heroes/:hero/upgrade/receipt'),
        {method:'GET',path:'/heroes/:hero/upgrade/receipt',query:'HeroUpgradeReceiptQuery',response:'HeroUpgradeReceipt'});
      assert.deepEqual(nativeEndpoints.find(value=>value.path==='/heroes/:hero/recovery/speedup/receipt'),
        {method:'GET',path:'/heroes/:hero/recovery/speedup/receipt',query:'HeroRecoveryReceiptQuery',response:'HeroRecoveryReceipt'});
      for(const name of ['TrainingCancellationResult','TrainingCancellationReceiptAcceptedResult']) {
        const declaration=kotlinClass(name);
        for(const field of ['id','troop','refundShards','cancelledAt']) assert.ok(declaration.includes('val '+field+': String,'));
        assert.ok(declaration.includes('val replayed: Boolean,'));
      }
    `,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});


function canonicalSourceTest(run, source) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync(process.execPath, ['--import', path.join(source, 'scripts/node_modules/tsx/dist/loader.mjs'), '--input-type=module'], {
    encoding: 'utf8', env: { ...process.env, PKW_TEST_SOURCE: source, PKW_TEST_ROOT: pathToFileURL(root + '/').href },
    input: `await (${run.toString()})();`,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function receiptTestSource() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return path.resolve(process.env.PKW_NATIVE_RECEIPT_SCHEMA_TEST_SOURCE ?? process.env.PKW_NATIVE_SCHEMA_TEST_SOURCE
    ?? process.env.PKW_NATIVE_SOURCE ?? path.join(root, '.source'));
}

test('optional economy receipts preserve canonical strict bounds, historical results and generated Kotlin types', () => {
  canonicalSourceTest(async () => {
    const assert = (await import('node:assert/strict')).default;
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    const source = process.env.PKW_TEST_SOURCE;
    const { nativeWireContracts, nativeContractMetadata } = await import(process.env.PKW_TEST_ROOT + 'tools/native-wire-contracts.mjs');
    const { kotlinModels } = await import(process.env.PKW_TEST_ROOT + 'tools/wire-contracts.mjs');
    const require = createRequire(source + '/apps/api/package.json');
    const compilerRequire = createRequire(createRequire(require.resolve('fastify')).resolve('@fastify/ajv-compiler'));
    const Ajv = compilerRequire('ajv/dist/2020.js').default;
    const schemas = await nativeWireContracts(source);
    const metadata = nativeContractMetadata(schemas);
    const ajv = new Ajv({ strict: false, validateFormats: false });
    ajv.addSchema({ schemas }, 'pack');
    const kotlin = kotlinModels('source', schemas);
    const kotlinClass = (name) => {
      const declaration = 'data class ' + name + 'Dto(';
      assert.ok(kotlin.includes(declaration), declaration);
      return kotlin.split(declaration)[1].split(')')[0];
    };
    const uuid = '11111111-1111-4111-8111-111111111111';
    const address = '1'.repeat(32);
    const decimal = '18446744073709551615';
    const key = 'receipt-abcdefgh';
    const timestamp = '2026-09-12T12:00:00.000Z';
    const extensions = [
      ['WithdrawalReceipt', 'apps/api/src/money/withdrawalReceipt.ts', '/withdrawals/receipt',
        { idempotencyKey: key, grossAmount: decimal, feeBurned: '0', netAmount: decimal,
          destination: address, mode: 'standard', cluster: 'devnet', keepMint: address },
        { withdrawalId: uuid, unbondsAt: timestamp }, 'KEEP'],
      ['ConversionReceipt', 'apps/api/src/game/conversionReceipt.ts', '/forge/convert/receipt',
        { idempotencyKey: key, keep: decimal, baseId: uuid },
        { converted: decimal, shards: decimal, rate: Number.MAX_SAFE_INTEGER }, 'KEEP'],
      ['ForgeContributionReceipt', 'apps/api/src/game/forgeContributionReceipt.ts', '/forge/contribute/receipt',
        { idempotencyKey: key, shards: decimal, baseId: uuid },
        { day: '2026-09-12', contributedShards: decimal }, 'SHARDS'],
    ];
    for (const [name, relative, endpoint, query, result, currency] of extensions) {
      if (!schemas[name]) {
        assert.ok(!process.env.PKW_NATIVE_RECEIPT_SCHEMA_TEST_SOURCE, 'Explicit modern source must contain ' + name);
        assert.ok(!schemas[name + 'Query']);
        assert.ok(!metadata.zod.includes(relative));
        assert.ok(!metadata.endpoints.some(({ path }) => path === endpoint));
        continue;
      }
      const canonical = await import(pathToFileURL(source + '/' + relative));
      const check = (schemaName, fixture, expected) => {
        const wire = JSON.parse(JSON.stringify(fixture));
        assert.equal(canonical[schemaName + 'Schema'].safeParse(wire).success, expected, schemaName + ' source ' + JSON.stringify(wire));
        const validate = ajv.getSchema('pack#/schemas/' + schemaName);
        assert.equal(validate(wire), expected, schemaName + ' export ' + JSON.stringify(validate.errors));
      };
      assert.deepEqual(metadata.endpoints.filter(({ path }) => path === endpoint), [
        { method: 'GET', path: endpoint, query: name + 'Query', response: name },
      ]);
      assert.equal(metadata.zod.filter((path) => path === relative).length, 1);
      check(name + 'Query', query, true);
      check(name + 'Query', { ...query, futureField: true }, false);
      check(name + 'Query', { ...query, idempotencyKey: '' }, false);
      check(name + 'Query', { ...query, idempotencyKey: 'a'.repeat(129) }, false);
      const amountField = name === 'WithdrawalReceipt' ? 'grossAmount' : name === 'ConversionReceipt' ? 'keep' : 'shards';
      for (const amount of [1, '', '0', '-1', '01', '1'.repeat(33)]) {
        check(name + 'Query', { ...query, [amountField]: amount }, false);
      }
      if (name !== 'WithdrawalReceipt') {
        check(name + 'Query', { ...query, baseId: undefined }, true);
        check(name + 'Query', { ...query, baseId: null }, false);
        check(name + 'Query', { ...query, baseId: 'not-a-uuid' }, false);
        assert.ok(kotlinClass(name + 'Query').includes('val baseId: String? = null,'));
      } else {
        for (const field of ['destination', 'keepMint']) {
          for (const value of ['1'.repeat(31), '1'.repeat(45), '0'.repeat(32)]) check(name + 'Query', { ...query, [field]: value }, false);
        }
        check(name + 'Query', { ...query, mode: 'fast' }, false);
        check(name + 'Query', { ...query, cluster: 'testnet' }, false);
        for (const field of ['grossAmount', 'feeBurned', 'netAmount', 'destination', 'mode', 'cluster', 'keepMint']) {
          check(name + 'Query', { ...query, [field]: undefined }, false);
          assert.ok(kotlinClass(name + 'Query').includes('val ' + field + ': String,'));
        }
        // A custom Zod BigInt refinement is not a JSON Schema keyword. Keep that
        // distinction visible; receipt proof must still check exact frozen amounts.
        const mismatched = { ...query, netAmount: '1' };
        assert.equal(canonical.WithdrawalReceiptQuerySchema.safeParse(mismatched).success, false);
        assert.equal(ajv.getSchema('pack#/schemas/WithdrawalReceiptQuery')(mismatched), true);
      }
      const receipt = { version: 1, status: 'accepted', wallet: address, request: query,
        receiptId: uuid, acceptedAt: timestamp, funding: { currency, amount: decimal }, result,
        ...(name === 'WithdrawalReceipt' ? {} : { baseId: uuid }) };
      check(name, receipt, true);
      check(name, { version: 1, status: 'unknown', idempotencyKey: key }, true);
      for (const fixture of [{ ...receipt, version: 2 }, { ...receipt, status: 'closed' },
        { ...receipt, receiptId: undefined }, { ...receipt, acceptedAt: undefined }, { ...receipt, result: undefined },
        { ...receipt, request: { ...query, futureField: true } },
        { ...receipt, funding: { currency: currency === 'KEEP' ? 'SHARDS' : 'KEEP', amount: decimal } },
        { ...receipt, funding: { currency, amount: 1 } },
        { ...receipt, funding: { currency, amount: '1'.repeat(33) } }]) check(name, fixture, false);
      assert.ok(kotlinClass(name + 'Accepted').includes('val request: ' + name + 'QueryDto,'));
      assert.ok(kotlinClass(name + 'Accepted').includes('val funding: ' + name + 'AcceptedFundingDto,'));
      assert.ok(kotlinClass(name + 'Accepted').includes('val result: ' + name + 'AcceptedResultDto,'));
      assert.ok(kotlinClass(name + 'AcceptedFunding').includes('val amount: String,'));
      assert.ok(kotlinClass(name + 'Unknown').includes('val idempotencyKey: String,'));
      if (name !== 'WithdrawalReceipt') {
        check(name, { ...receipt, baseId: null, request: { ...query, baseId: undefined } }, true);
        check(name, { ...receipt, baseId: undefined }, false);
        assert.ok(kotlinClass(name + 'Accepted').includes('val baseId: String?,'));
        assert.ok(!kotlinClass(name + 'Accepted').includes('val baseId: String? = null,'));
      }
      if (name === 'ConversionReceipt') {
        assert.ok(kotlinClass(name + 'AcceptedResult').includes('val rate: Long,'));
        for (const rate of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) check(name, { ...receipt, result: { ...result, rate } }, false);
        check(name, { ...receipt, result: { ...result, shards: 1 } }, false);
      }
      if (name === 'ForgeContributionReceipt') {
        assert.ok(kotlinClass(name + 'AcceptedResult').includes('val day: String,'));
        check(name, { ...receipt, result: { ...result, day: '2026-9-12' } }, false);
        check(name, { ...receipt, result: { ...result, contributedShards: 1 } }, false);
      }
    }
    for (const relative of ['apps/api/src/game/heroConsent.ts', 'apps/api/src/game/heroReceipt.ts']) {
      assert.equal(metadata.zod.filter((path) => path === relative).length, 1);
    }
    for (const [name] of extensions) {
      assert.throws(() => nativeContractMetadata({ [name]: {} }), /Incomplete canonical native receipt/);
      assert.throws(() => nativeContractMetadata({ [name + 'Query']: {} }), /Incomplete canonical native receipt/);
    }
  }, receiptTestSource());
});

test('legacy sources omit additive receipts but advertised missing, partial or malformed modules fail export', () => {
  canonicalSourceTest(async () => {
    const assert = (await import('node:assert/strict')).default;
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const { nativeWireContracts, nativeContractMetadata } = await import(process.env.PKW_TEST_ROOT + 'tools/native-wire-contracts.mjs');
    const source = process.env.PKW_TEST_SOURCE;
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pkw-receipt-contracts-'));
    const fixtures = [
      ['WithdrawalReceipt', 'money/withdrawalReceipt.ts', 'WITHDRAWAL_RECEIPT_FEATURE', '/withdrawals/receipt'],
      ['ConversionReceipt', 'game/conversionReceipt.ts', 'CONVERSION_RECEIPT_FEATURE', '/forge/convert/receipt'],
      ['ForgeContributionReceipt', 'game/forgeContributionReceipt.ts', 'FORGE_CONTRIBUTION_RECEIPT_FEATURE', '/forge/contribute/receipt'],
    ];
    try {
      let caseId = 0;
      const overlay = async (routes, filename, content) => {
        const root = path.join(temporary, String(caseId++));
        for (const directory of ['game', 'money', 'native']) await fs.mkdir(path.join(root, 'apps/api/src', directory), { recursive: true });
        await fs.symlink(path.join(source, 'apps/api/node_modules'), path.join(root, 'apps/api/node_modules'));
        await fs.symlink(path.join(source, 'apps/api/package.json'), path.join(root, 'apps/api/package.json'));
        for (const relative of ['native/contracts.ts', 'game/trainingRecovery.ts', 'game/constructionReceipt.ts',
          'game/trainingCancellationReceipt.ts', 'game/trainingSchedule.ts', 'game/researchConsent.ts', 'game/heroConsent.ts', 'game/heroReceipt.ts']) {
          await fs.symlink(path.join(source, 'apps/api/src', relative), path.join(root, 'apps/api/src', relative));
        }
        await fs.writeFile(path.join(root, 'apps/api/src/game/routes.ts'), routes);
        if (filename) await fs.writeFile(path.join(root, 'apps/api/src', filename), content);
        return root;
      };
      const old = await nativeWireContracts(await overlay('// source predates economy receipts'));
      const oldMetadata = nativeContractMetadata(old);
      for (const [name, , , endpoint] of fixtures) {
        assert.ok(!old[name] && !old[name + 'Query']);
        assert.ok(!oldMetadata.endpoints.some(({ path }) => path === endpoint));
      }
      for (const [name, filename, feature, endpoint] of fixtures) {
        const advertised = feature + ' ' + endpoint;
        await assert.rejects(nativeWireContracts(await overlay(advertised)), /Incomplete canonical native receipt support/);
        await assert.rejects(nativeWireContracts(await overlay(feature)), /Incomplete canonical native receipt support/);
        await assert.rejects(nativeWireContracts(await overlay(endpoint)), /Incomplete canonical native receipt support/);
        await assert.rejects(nativeWireContracts(await overlay('', filename, 'export {};')), /Incomplete canonical native receipt support/);
        await assert.rejects(nativeWireContracts(await overlay(advertised, filename,
          'export const ' + feature + ' = {version: 2};')), /Unsupported canonical native receipt feature/);
        await assert.rejects(nativeWireContracts(await overlay(advertised, filename,
          'export const ' + feature + ' = {version: 1};')), /Malformed canonical native receipt schemas/);
        await assert.rejects(nativeWireContracts(await overlay(advertised, filename,
          `import {z} from 'zod'; export const ${feature} = {version: 1}; export const ${name}QuerySchema = z.string(); export const ${name}Schema = z.string();`)), /Malformed canonical native receipt schemas/);
        await assert.rejects(nativeWireContracts(await overlay(advertised, filename,
          `import './absent-dependency.js'; export const ${feature} = {version: 1};`)), /absent-dependency/);
      }
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }, receiptTestSource());
});
