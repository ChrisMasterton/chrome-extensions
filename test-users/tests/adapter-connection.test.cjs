const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

const capabilities = { label:'Current adapter', roles:['Member'], scenarios:[], capabilities:{reset:true} };
const start = (state, contextKey, requestId) => Core.transitionAdapterConnection(state,{type:'start',contextKey,requestId});
const outcome = (state, type, contextKey, requestId, extra={}) => Core.transitionAdapterConnection(state,{type,contextKey,requestId,...extra});

test('only a pending current check can install normalized capabilities', () => {
  let state = start(null,'saved settings','check-1');
  state = outcome(state,'succeed','saved settings','check-1',{capabilities});
  assert.equal(state.status,'ready');
  assert.equal(state.requestId,null);
  assert.equal(state.capabilities.roles[0].id,'Member');
  assert.equal(state.capabilities.canReset,true);
  assert.equal(outcome(state,'fail','saved settings','check-1',{error:'late failure'}),state);
});

test('settings changes, retries, and changing settings back never revive an older check', () => {
  const first = start(null,'first settings','old-check');
  const current = start(first,'second settings','new-check');
  for (const type of ['succeed','fail']) assert.equal(
    outcome(current,type,'first settings','old-check',{capabilities,error:'old failure'}),current);
  const retry = start(current,'second settings','retry');
  assert.equal(outcome(retry,'succeed','second settings','new-check',{capabilities}),retry);
  const restored = start(retry,'first settings','restored-check');
  assert.equal(outcome(restored,'succeed','first settings','old-check',{capabilities}),restored);
});

test('failure clears capabilities and a retry can recover without a sticky request token', () => {
  const failed = outcome(start(null,'settings','first'),'fail','settings','first',{error:'  service\n unavailable  '});
  assert.equal(failed.status,'error');
  assert.equal(failed.capabilities,null);
  assert.equal(failed.requestId,null);
  assert.equal(failed.error,'service unavailable');
  const recovered = outcome(start(failed,'settings','retry'),'succeed','settings','retry',{capabilities});
  assert.equal(recovered.status,'ready');
  assert.equal(recovered.error,'');
});

test('disabled and superseded checks cannot accept metadata, and current metadata still rejects credential fields', () => {
  const pending = start(null,'settings','first');
  const disabled = Core.transitionAdapterConnection(pending,{type:'disable',contextKey:'empty settings'});
  const invalid = {...capabilities,password:'must never be accepted'};
  assert.equal(outcome(disabled,'succeed','settings','first',{capabilities:invalid}),disabled);
  assert.equal(disabled.capabilities,null);
  assert.throws(() => outcome(pending,'succeed','settings','first',{capabilities:invalid}),/must not include password/);
});
