const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { buildSync } = require('esbuild');

// Exercise the actual plugin with simulated Obsidian HTTP/UI APIs. No real keys,
// billable requests, microphone access, or changes to a user's vault are needed.
const pluginCode = buildSync({
  entryPoints: [path.join(__dirname, '..', 'main.ts')],
  bundle: true, external: ['obsidian'], platform: 'browser', format: 'cjs',
  target: 'es2018', write: false,
}).outputFiles[0].text;

function response({ status = 200, code = '20000000', text = '测试录音内容', message = '', headers = {} } = {}) {
  return {
    status, headers: { 'X-Api-Status-Code': code, 'X-Api-Message': message, ...headers },
    text: JSON.stringify({ result: { text } }),
  };
}

async function harness(saved = {}, httpResponse = response()) {
  const calls = [], notices = [], rows = [], guides = [];
  let persisted = saved, tab, recorded = 0;
  const audio = new Blob([new Uint8Array([82, 73, 70, 70, 0, 255, 128])], { type: 'audio/wav' });
  class Component {
    constructor() { this.inputEl = { addEventListener() {} }; this.options = {}; }
    setValue(value) { this.value = value; return this; }
    getValue() { return this.value; }
    addOption(value, name) { this.options[value] = name; return this; }
    onChange(callback) { this.change = callback; return this; }
    setButtonText() { return this; }
    onClick(callback) { this.click = callback; return this; }
  }
  class Setting {
    constructor() { rows.push(this); }
    setName(name) { this.name = name; return this; }
    setDesc(desc) { this.desc = desc; return this; }
    setHeading() { return this; }
    addDropdown(cb) { this.control = new Component(); cb(this.control); return this; }
    addText(cb) { return this.addDropdown(cb); }
    addTextArea(cb) { return this.addDropdown(cb); }
    addToggle(cb) { return this.addDropdown(cb); }
    addButton(cb) { return this.addDropdown(cb); }
  }
  class Plugin {
    loadData() { return Promise.resolve(persisted); }
    saveData(data) { persisted = JSON.parse(JSON.stringify(data)); return Promise.resolve(); }
    addRibbonIcon() {}
    addCommand() {}
    addSettingTab(value) { tab = value; }
    addStatusBarItem() { return { setText() {}, remove() {} }; }
  }
  class Modal {
    constructor(app) { this.app = app; }
    open() { recorded++; this.resolve(audio); }
  }
  class PluginSettingTab {
    constructor() {
      this.containerEl = {
        empty() { rows.length = 0; guides.length = 0; },
        createDiv(options) { guides.push(options.text); },
      };
    }
  }
  class TFile {}
  class FileReader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(buffer => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
        this.onload();
      }).catch(() => this.onerror());
    }
  }
  const obsidian = {
    Plugin, Modal, PluginSettingTab, Setting, TFile,
    Notice: class { constructor(message) { notices.push(message); } },
    Platform: { isMobileApp: false }, normalizePath: value => value,
    async requestUrl(options) {
      calls.push(options);
      if (httpResponse instanceof Error) throw httpResponse;
      if (typeof httpResponse === 'function') return httpResponse(options, calls.length - 1);
      return httpResponse;
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(pluginCode, {
    module, exports: module.exports, require: name => {
      assert.equal(name, 'obsidian'); return obsidian;
    },
    Blob, TextEncoder, Uint8Array, ArrayBuffer, FileReader,
    console: { error() {}, warn() {} },
    window: { crypto: webcrypto, setTimeout(callback) { callback(); } },
  });
  const plugin = new module.exports.default();
  plugin.app = {};
  await plugin.onload();
  return {
    plugin, calls, notices, rows, guides, audio, tab, TFile,
    get persisted() { return persisted; }, get recorded() { return recorded; },
  };
}

const doubao = { sttProvider: 'doubao', doubaoApiKey: ' fake-voice-key ', aiApiKey: 'fake-ai-key' };

test('new settings default to standard while existing Doubao settings retain flash', async () => {
  assert.equal((await harness(null)).plugin.settings.doubaoMode, 'standard');
  assert.equal((await harness(doubao)).plugin.settings.doubaoMode, 'flash');
  const h = await harness(doubao);
  h.tab.display();
  await h.rows.find(row => row.name === '豆包识别模式').control.change('standard');
  const reloaded = await harness(h.persisted);
  assert.equal(reloaded.plugin.settings.doubaoMode, 'standard');
  assert.equal(reloaded.plugin.settings.doubaoApiKey, doubao.doubaoApiKey);
});

test('standard submits audio once and polls the same task through queue and processing', async () => {
  const sequence = [
    { ...response(), text: '{}' }, response({ code: '20000002' }),
    response({ code: '20000001' }), response({ text: ' 标准版识别成功。 ' }),
  ];
  const h = await harness({ ...doubao, doubaoMode: 'standard' }, (_, index) => sequence[index]);
  assert.equal(await h.plugin.callSTT(h.audio), '标准版识别成功。');
  assert.equal(h.calls.length, 4);
  assert.ok(h.calls[0].url.endsWith('/submit'));
  assert.equal(JSON.parse(h.calls[0].body).audio.format, 'wav');
  assert.equal(Buffer.from(JSON.parse(h.calls[0].body).audio.data, 'base64').toString('hex'), Buffer.from(await h.audio.arrayBuffer()).toString('hex'));
  for (const req of h.calls) {
    assert.equal(req.headers['X-Api-Request-Id'], h.calls[0].headers['X-Api-Request-Id']);
    assert.equal(req.headers['X-Api-Resource-Id'], 'volc.seedasr.auc');
    assert.equal(req.headers['X-Api-Key'], 'fake-voice-key');
  }
  for (const req of h.calls.slice(1)) {
    assert.ok(req.url.endsWith('/query'));
    assert.equal(req.body, '{}');
  }
});

test('standard query silence and errors cannot become transcripts', async () => {
  for (const [final, expected] of [
    [response({ code: '20000003' }), null],
    [response({ status: 403, message: 'resource not granted' }), /标准版 2.0.*volc.seedasr.auc/],
    [{ ...response(), text: '{}' }, /缺少文字/],
  ]) {
    const h = await harness({ ...doubao, doubaoMode: 'standard' }, (_, index) => index ? final : { ...response(), text: '{}' });
    if (expected) await assert.rejects(h.plugin.callSTT(h.audio), expected);
    else assert.equal(await h.plugin.callSTT(h.audio), '');
    assert.equal(h.calls.length, 2);
  }
});

test('standard timeout stops polling and keeps the recording without calling AI', async () => {
  const h = await harness({ ...doubao, doubaoMode: 'standard' }, (_, index) => response({ code: index ? '20000001' : '20000000' }));
  let savedAudio = 0, summarized = 0;
  h.plugin.saveAudio = async () => { savedAudio++; return '录音/test.wav'; };
  h.plugin.callAI = async () => { summarized++; };
  await h.plugin.startRecordFlow();
  assert.equal(h.calls.length, 151);
  assert.equal(savedAudio, 1);
  assert.equal(summarized, 0);
  assert.ok(h.notices.some(message => /等待超时/.test(message)));
  assert.equal(h.plugin.isBusy, false);
});

test('legacy settings keep their existing compatible endpoint and credentials', async () => {
  const h = await harness({ sttApiUrl: 'https://example.invalid/audio/transcriptions', sttApiKey: 'old-key', sttModel: 'old-model' });
  assert.equal(h.plugin.settings.sttProvider, 'compatible');
  assert.equal(h.plugin.settings.sttApiUrl, 'https://example.invalid/audio/transcriptions');
  assert.equal(h.plugin.settings.sttApiKey, 'old-key');
  assert.equal(h.plugin.settings.sttModel, 'old-model');
  assert.equal(h.plugin.settings.doubaoAuthMode, 'api-key');
});

test('provider selector preserves both sets of credentials across switching and reload', async () => {
  const h = await harness({ ...doubao, sttProvider: 'compatible', sttApiKey: 'old-key' });
  h.tab.display();
  await h.rows.find(row => row.name === '语音识别服务').control.change('doubao');
  assert.equal(h.rows.find(row => row.name === '豆包语音 API Key').control.inputEl.type, 'password');
  assert.ok(!h.rows.some(row => row.name === 'STT 模型'));
  await h.rows.find(row => row.name === '语音识别服务').control.change('compatible');
  assert.equal(h.rows.find(row => row.name === 'STT API Key').control.value, 'old-key');
  const reloaded = await harness(h.persisted);
  assert.equal(reloaded.plugin.settings.sttProvider, 'compatible');
  assert.equal(reloaded.plugin.settings.doubaoApiKey, doubao.doubaoApiKey);
});

test('legacy auth fields are shown and saved independently from the new API Key', async () => {
  const h = await harness(doubao);
  h.tab.display();
  await h.rows.find(row => row.name === '豆包语音鉴权方式').control.change('app-token');
  assert.ok(!h.rows.some(row => row.name === '豆包语音 API Key'));
  await h.rows.find(row => row.name === '豆包语音 APP ID').control.change('12345');
  const token = h.rows.find(row => row.name === '豆包语音 Access Token').control;
  assert.equal(token.inputEl.type, 'password');
  await token.change('legacy-token');
  const reloaded = await harness(h.persisted);
  assert.equal(reloaded.plugin.settings.doubaoAppId, '12345');
  assert.equal(reloaded.plugin.settings.doubaoAccessToken, 'legacy-token');
  assert.equal(reloaded.plugin.settings.doubaoApiKey, doubao.doubaoApiKey);
});

test('Doubao sends original WAV bytes in JSON with new-console headers and extracts only text', async () => {
  const h = await harness(doubao, response({ text: '  你好，世界。  ' }));
  assert.equal(await h.plugin.callSTT(h.audio), '你好，世界。');
  const req = h.calls[0], body = JSON.parse(req.body);
  assert.equal(req.url, 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash');
  assert.equal(req.headers['X-Api-Key'], 'fake-voice-key');
  assert.equal(req.headers['X-Api-Resource-Id'], 'volc.bigasr.auc_turbo');
  assert.equal(req.headers['X-Api-Sequence'], '-1');
  assert.match(req.headers['X-Api-Request-Id'], /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(req.headers.Authorization, undefined);
  assert.equal(req.headers['X-Api-App-Key'], undefined);
  assert.equal(req.throw, false);
  assert.equal(Buffer.from(body.audio.data, 'base64').toString('hex'), Buffer.from(await h.audio.arrayBuffer()).toString('hex'));
  assert.equal(body.audio.url, undefined);
  assert.equal(body.request.model_name, 'bigmodel');
  assert.equal(body.request.enable_punc, true);
});

test('old-console credentials use APP ID and Access Token without requiring a SiliconFlow key', async () => {
  const h = await harness({ ...doubao, doubaoAuthMode: 'app-token', doubaoApiKey: '', doubaoAppId: ' 12345 ', doubaoAccessToken: ' old-token ' });
  assert.equal(h.plugin.validateProcessingSettings(), true);
  await h.plugin.callSTT(h.audio);
  assert.equal(h.calls[0].headers['X-Api-App-Key'], '12345');
  assert.equal(h.calls[0].headers['X-Api-Access-Key'], 'old-token');
  assert.equal(h.calls[0].headers['X-Api-Key'], undefined);
});

test('request IDs are distinct for successive recordings', async () => {
  const h = await harness(doubao);
  await h.plugin.callSTT(h.audio); await h.plugin.callSTT(h.audio);
  assert.notEqual(h.calls[0].headers['X-Api-Request-Id'], h.calls[1].headers['X-Api-Request-Id']);
});

test('WebM recordings are converted before being sent to Doubao', async () => {
  const h = await harness(doubao);
  const original = new Blob(['webm recording'], { type: 'audio/webm' });
  h.plugin.convertToWav = async blob => { assert.equal(blob, original); return h.audio; };
  await h.plugin.callSTT(original);
  assert.equal(JSON.parse(h.calls[0].body).audio.data, Buffer.from(await h.audio.arrayBuffer()).toString('base64'));
});

test('undecodable WebM is rejected without submitting an unsupported format', async () => {
  const h = await harness(doubao);
  h.plugin.convertToWav = async () => { throw new Error('decode failed'); };
  await assert.rejects(h.plugin.callSTT(new Blob(['webm'], { type: 'audio/webm' })), /支持的格式/);
  assert.equal(h.calls.length, 0);
});

test('explicit OGG Opus can be sent when WAV conversion is unavailable', async () => {
  const h = await harness(doubao);
  h.plugin.convertToWav = async () => { throw new Error('decode failed'); };
  await h.plugin.callSTT(new Blob(['ogg opus'], { type: 'audio/ogg;codecs=opus' }));
  assert.equal(h.calls.length, 1);
});

test('oversized source and converted audio are rejected before encoding or HTTP', async () => {
  const h = await harness(doubao);
  const huge = { size: 100 * 1024 * 1024 + 1, type: 'audio/wav' };
  await assert.rejects(h.plugin.callSTT(huge), /100 MB/);
  h.plugin.convertToWav = async () => huge;
  await assert.rejects(h.plugin.callSTT(new Blob(['webm'], { type: 'audio/webm' })), /100 MB/);
  assert.equal(h.calls.length, 0);
});

test('compatible APIs still receive multipart audio with Bearer auth and pure-text response format', async () => {
  const h = await harness({ sttApiKey: 'old-key', sttModel: 'whisper-large-v3', sttApiUrl: 'https://example.invalid/audio/transcriptions' }, { status: 200, text: '兼容接口的文字' });
  assert.equal(await h.plugin.callSTT(new Blob(['mp3'], { type: 'audio/mpeg' })), '兼容接口的文字');
  const req = h.calls[0], body = Buffer.from(req.body).toString();
  assert.equal(req.headers.Authorization, 'Bearer old-key');
  assert.match(req.headers['Content-Type'], /^multipart\/form-data; boundary=/);
  assert.match(body, /filename="audio.mp3"/);
  assert.match(body, /name="model"\r\n\r\nwhisper-large-v3/);
  assert.match(body, /name="language"\r\n\r\nzh/);
  assert.match(body, /name="response_format"\r\n\r\ntext/);
});

test('upstream compressed uploads and JSON transcript parsing are preserved', async () => {
  for (const [mime, extension] of [['audio/webm', 'webm'], ['audio/mp4', 'm4a'], ['audio/flac', 'flac'], ['audio/aac', 'aac']]) {
    const h = await harness({ sttApiKey: 'old-key' }, { status: 200, text: '{"text":"转写结果"}', json: { text: '转写结果' } });
    h.plugin.convertToWav = async () => { throw new Error('Compressed compatible recordings must not be converted'); };
    assert.equal(await h.plugin.callSTT(new Blob(['compressed-data'], { type: mime })), '转写结果');
    const body = Buffer.from(h.calls[0].body).toString();
    assert.ok(body.includes(`filename="audio.${extension}"`));
    assert.ok(body.includes('compressed-data'));
  }
});

test('upstream defaults and user choices survive the Doubao upgrade', async () => {
  const fresh = await harness(null);
  assert.equal(fresh.plugin.settings.maxRecordMinutes, 60);
  assert.equal(fresh.plugin.settings.showFloatingButton, true);
  assert.equal(fresh.plugin.settings.deleteAfterProcess, false);
  const prior = { maxRecordMinutes: 30, showFloatingButton: false, deleteAfterProcess: true, aiModel: 'custom-model', aiApiUrl: 'https://example.invalid/chat/completions' };
  const h = await harness(prior);
  for (const [key, value] of Object.entries(prior)) assert.equal(h.plugin.settings[key], value);
});

test('note-write failures retain audio even when deletion is enabled', async () => {
  const h = await harness({ ...doubao, deleteAfterProcess: true });
  let deleted = false;
  h.plugin.saveAudio = async () => '录音/example.wav';
  h.plugin.callAI = async () => '### 类型\n备忘录\n### 备忘内容\n测试内容';
  h.plugin.saveMemo = async () => { throw new Error('write failed'); };
  h.plugin.app = { vault: { getAbstractFileByPath: () => new h.TFile() }, fileManager: { trashFile: async () => { deleted = true; } } };
  await h.plugin.startRecordFlow();
  assert.equal(deleted, false);
  assert.equal(h.plugin.isBusy, false);
  assert.ok(h.notices.some(message => /write failed/.test(message)));
});

test('Doubao status headers are matched without case sensitivity', async () => {
  const h = await harness(doubao, { status: 200, headers: { 'x-api-status-code': '20000000' }, text: '{"result":{"text":"识别成功"}}' });
  assert.equal(await h.plugin.callSTT(h.audio), '识别成功');
});

test('silent audio returns no text instead of passing JSON to the AI', async () => {
  const h = await harness(doubao, response({ code: '20000003' }));
  assert.equal(await h.plugin.callSTT(h.audio), '');
});

test('business errors in HTTP 200 responses reject with actionable messages', async () => {
  for (const [code, expected] of [['45000151', /音频格式/], ['45000002', /空音频/], ['55000031', /繁忙/], ['45000001', /45000001.*bad parameters/]]) {
    const h = await harness(doubao, response({ code, message: 'bad parameters' }));
    await assert.rejects(h.plugin.callSTT(h.audio), expected);
  }
});

test('HTTP errors and network failures do not become transcripts', async () => {
  for (const [status, expected] of [[401, /鉴权/], [403, /无权限/], [402, /余额/], [429, /频繁/], [500, /500/]]) {
    const h = await harness(doubao, response({ status }));
    await assert.rejects(h.plugin.callSTT(h.audio), expected);
  }
  const h = await harness(doubao, new Error('connection refused'));
  await assert.rejects(h.plugin.callSTT(h.audio), /网络/);
});

test('403 preserves the server reason, status code, and trace ID instead of hiding the cause', async () => {
  const h = await harness(doubao, {
    status: 403,
    headers: { 'x-api-status-code': '45000000', 'x-tt-logid': '20261012-test-id' },
    text: JSON.stringify({ error: 'requested resource volc.bigasr.auc_turbo is not granted' }),
  });
  await assert.rejects(h.plugin.callSTT(h.audio), error => {
    assert.match(error.message, /HTTP 403 \/ 45000000/);
    assert.match(error.message, /resource volc.bigasr.auc_turbo is not granted/);
    assert.match(error.message, /20261012-test-id/);
    return true;
  });
});

test('invalid Key details are visible while any echoed credential is redacted before truncation', async () => {
  const h = await harness(doubao, {
    status: 401, headers: {},
    text: JSON.stringify({ error: { message: 'Invalid X-Api-Key: fake-voice-key' } }),
  });
  await assert.rejects(h.plugin.callSTT(h.audio), error => {
    assert.match(error.message, /Invalid X-Api-Key/);
    assert.match(error.message, /已隐藏凭证/);
    assert.ok(!error.message.includes('fake-voice-key'));
    return true;
  });
});

test('plain-text errors are retained but HTML error pages are not dumped into notices', async () => {
  const plain = await harness(doubao, { status: 403, headers: {}, text: 'access denied for this project' });
  await assert.rejects(plain.plugin.callSTT(plain.audio), /access denied for this project/);
  const html = await harness(doubao, { status: 502, headers: {}, text: '<html>gateway error</html>' });
  await assert.rejects(html.plugin.callSTT(html.audio), error => {
    assert.match(error.message, /HTTP 502/);
    assert.ok(!error.message.includes('<html>'));
    return true;
  });
});

test('missing status or malformed/missing transcript results are rejected', async () => {
  for (const body of ['not json', 'null', '{}', '{"result":{"text":42}}']) {
    const h = await harness(doubao, { ...response(), text: body });
    await assert.rejects(h.plugin.callSTT(h.audio), /无效结果|缺少文字/);
  }
  const h = await harness(doubao, { ...response(), headers: {} });
  await assert.rejects(h.plugin.callSTT(h.audio), /缺少服务状态码/);
});

test('missing selected-provider credentials prevent both recording and batch processing', async () => {
  for (const saved of [
    { ...doubao, doubaoApiKey: ' ', sttApiKey: 'unrelated-key' },
    { ...doubao, doubaoAuthMode: 'app-token', doubaoAppId: '12345', doubaoAccessToken: '' },
    { ...doubao, aiApiKey: '' },
  ]) {
    const h = await harness(saved);
    await h.plugin.startRecordFlow(); await h.plugin.processInbox();
    assert.equal(h.recorded, 0);
    assert.equal(h.calls.length, 0);
    assert.equal(h.notices.length, 2);
  }
});

test('recording and batch processing keep original audio after business errors or silence', async () => {
  for (const code of ['45000151', '20000003']) {
    const h = await harness(doubao, response({ code }));
    let savedAudio = 0, deletedAudio = 0, summarized = 0;
    h.plugin.saveAudio = async () => { savedAudio++; return '录音/example.webm'; };
    h.plugin.callAI = async () => { summarized++; throw new Error('AI must not run'); };
    h.plugin.app = {
      vault: {
        adapter: {
          exists: async () => true, list: async () => ({ files: ['录音/example.wav'] }),
          readBinary: async () => h.audio.arrayBuffer(),
        },
        getAbstractFileByPath: () => new h.TFile(),
      },
      fileManager: { trashFile: async () => { deletedAudio++; } },
    };
    await h.plugin.startRecordFlow();
    await h.plugin.processInbox();
    assert.equal(h.recorded, 1);
    assert.equal(savedAudio, 1);
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls.every(req => req.url.includes('/recognize/flash')));
    assert.equal(summarized, 0);
    assert.equal(deletedAudio, 0);
    assert.equal(h.plugin.isBusy, false);
  }
});

test('successful Doubao recordings and batch files feed text to AI, save notes, then remove processed audio', async () => {
  const h = await harness({ ...doubao, deleteAfterProcess: true });
  const events = [];
  h.plugin.saveAudio = async () => '录音/example.webm';
  h.plugin.callAI = async text => {
    assert.equal(text, '测试录音内容');
    events.push('AI');
    return '### 标题\n测试备忘\n### 类型\n备忘录\n### 总结\n整理后的内容\n### 备忘内容\n整理后的内容';
  };
  h.plugin.saveMemo = async (transcript, memo, audioPath, title) => {
    assert.equal(transcript, '测试录音内容');
    assert.equal(memo, '整理后的内容');
    assert.equal(title, '测试备忘');
    assert.match(audioPath, /^录音\//);
    events.push('note');
  };
  h.plugin.app = {
    vault: {
      adapter: {
        exists: async () => true, list: async () => ({ files: ['录音/example.WAV'] }),
        readBinary: async () => h.audio.arrayBuffer(),
      },
      getAbstractFileByPath: () => new h.TFile(),
    },
    fileManager: { trashFile: async () => { events.push('delete'); } },
  };
  await h.plugin.startRecordFlow();
  await h.plugin.processInbox();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(events, ['AI', 'note', 'delete', 'AI', 'note', 'delete']);
  assert.equal(h.plugin.isBusy, false);
});
