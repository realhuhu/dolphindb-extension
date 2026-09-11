import { Dialog, showDialog } from '@jupyterlab/apputils';
import { Button, FilterBox, InputGroup, ToolbarButtonComponent } from '@jupyterlab/ui-components';
import { addIcon, refreshIcon, settingsIcon } from './icons';
import { Checkbox, Toolbar, type CheckboxElement } from '@jupyter/react-components';
import * as React from 'react';
import { endpoint, type Draft, type Profile } from './api';
import { ConnectionModel } from './model';
import { sortConnections } from './settings';

function DatabaseMark(): React.ReactElement {
  return <svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><ellipse cx="20" cy="10" rx="13" ry="5"/><path d="M7 10v10c0 2.8 5.8 5 13 5s13-2.2 13-5V10M7 20v10c0 2.8 5.8 5 13 5s13-2.2 13-5V20"/></svg>;
}

export function ConnectionPanel({ model, onOpenSettings }: { model: ConnectionModel; onOpenSettings: () => void }): React.ReactElement {
  const [, update] = React.useReducer(n => n + 1, 0);
  const [editing, setEditing] = React.useState<Profile | 'new' | null>(null);
  const [filter, setFilter] = React.useState('');
  const updateFilter = React.useCallback((_filter: unknown, query?: string) => setFilter(query ?? ''), []);
  const { sidebar } = model.preferences.value;
  const showSearch = sidebar.alwaysShowSearch || model.state.connections.length > 3;
  React.useEffect(() => { if (!showSearch) { setFilter(''); } }, [showSearch]);
  React.useEffect(() => {
    const changed = () => update();
    model.changed.connect(changed);
    void model.refresh();
    let connected = model.connected;
    const timer = setInterval(() => {
      if (connected !== model.connected) { connected = model.connected; update(); }
    }, 1000);
    return () => { clearInterval(timer); model.changed.disconnect(changed); };
  }, [model]);

  const active = model.state.connections.find(p => p.id === (model.current?.id || model.state.activeId));
  const query = showSearch ? filter.toLowerCase() : '';
  const profiles = sortConnections(model.state.connections, sidebar.sortOrder)
    .filter(p => `${p.name} ${p.host} ${p.username}`.toLowerCase().includes(query));
  const edit = (profile: Profile | 'new') => { model.notice = null; setEditing(profile); };
  const remove = async (profile: Profile) => {
    const result = await showDialog({
      title: `删除「${profile.name}」？`,
      body: '将移除这项连接配置和保存的密码，并断开对应连接。数据库中的数据不会被删除。',
      buttons: [Dialog.cancelButton({ label: '取消' }), Dialog.warnButton({ label: '删除连接' })],
    });
    if (result.button.accept) { await model.remove(profile); }
  };

  return <section className="ddb-panel" aria-label="DolphinDB 连接管理" aria-busy={Boolean(model.busy)}>
    <header className="ddb-header">
      <div className="ddb-brand"><span className="ddb-brand-mark"><DatabaseMark /></span><div><strong>DolphinDB</strong><span>CONNECTIONS</span></div></div>
      {!editing && <Toolbar aria-label="连接管理工具栏">
        <ToolbarButtonComponent icon={settingsIcon} tooltip="打开 DolphinDB 设置" onClick={onOpenSettings}/>
        <ToolbarButtonComponent icon={refreshIcon} tooltip="刷新连接列表" enabled={!model.busy} onClick={() => void model.refresh()}/>
        <ToolbarButtonComponent icon={addIcon} tooltip="新增连接" enabled={!model.busy} onClick={() => edit('new')}/>
      </Toolbar>}
    </header>
    {model.notice && <div role={model.notice.kind === 'error' ? 'alert' : 'status'} className={`ddb-notice ddb-notice-${model.notice.kind}`}>{model.notice.text}</div>}
    {editing ? <ConnectionForm key={editing === 'new' ? 'new' : editing.id} profile={editing === 'new' ? undefined : editing} model={model} onClose={() => setEditing(null)} /> : <>
      <div className="ddb-current">
        <div className="ddb-eyebrow"><span className={`ddb-dot ${model.connected ? 'is-online' : ''}`} />{model.connected ? '当前连接' : active ? '上次选择' : '当前连接'}<span className="ddb-status-label">{model.connected ? '已连接' : '未连接'}</span></div>
        <strong className="ddb-current-name">{active?.name || '尚未选择连接'}</strong>
        {model.connected && model.current ? <>
          <span className="ddb-current-detail">{model.current.connection.node_alias} · v{model.current.connection.version}</span>
          <Button minimal small disabled={Boolean(model.busy)} onClick={() => model.disconnect()}>断开连接</Button>
        </> : <span className="ddb-current-detail">{active ? '点击下方连接，继续工作。' : '配置服务器，开始使用 DolphinDB。'}</span>}
      </div>
      <div className="ddb-list-heading"><h2>已保存的连接 <span>{model.state.connections.length}</span></h2></div>
      {showSearch && <div className="ddb-search"><FilterBox placeholder="搜索名称或地址…" useFuzzyFilter={false} updateFilter={updateFilter}/></div>}
      <div className="ddb-list">
        {!model.loaded && !model.notice ? <p className="ddb-loading" role="status">正在加载连接…</p> : model.loaded && !model.state.connections.length ? <div className="ddb-empty">
          <DatabaseMark /><h3>添加第一个连接</h3><p>填写服务器地址和登录信息，<br />连接配置会自动保存。</p>
          <Button onClick={() => edit('new')}>＋ 新增连接</Button>
        </div> : profiles.map(profile => {
          const selected = model.current?.id === profile.id && model.connected;
          const connecting = model.busy === `connect:${profile.id}`;
          return <article className={`ddb-connection ${selected ? 'is-selected' : ''}`} key={profile.id} aria-label={`连接 ${profile.name}`}>
            <div className="ddb-connection-title"><h3>{profile.name}</h3>{selected && <span className="ddb-badge">当前</span>}</div>
            <code className="ddb-endpoint">{endpoint(profile)}</code>
            {sidebar.showConnectionDetails && <div className="ddb-connection-meta"><span>{profile.username || '匿名用户'}</span><span>{profile.ssl ? 'SSL' : '标准连接'}</span></div>}
            <div className="ddb-connection-actions">
              <Button disabled={Boolean(model.busy) || selected} onClick={() => void model.connect(profile)}>{connecting ? '连接中…' : selected ? '✓ 已连接' : model.connected ? '切换连接' : '连接'}</Button>
              <Button minimal small disabled={Boolean(model.busy)} aria-label={`编辑 ${profile.name}`} onClick={() => edit(profile)}>编辑</Button>
              <Button minimal small disabled={Boolean(model.busy)} aria-label={`删除 ${profile.name}`} onClick={() => void remove(profile)}>删除</Button>
            </div>
          </article>;
        })}
        {query && !profiles.length && <p className="ddb-loading">没有匹配的连接。</p>}
      </div>
      <footer className="ddb-footer">连接地址由 Jupyter 所在机器访问。</footer>
    </>}
  </section>;
}

function ConnectionForm({ profile, model, onClose }: { profile?: Profile; model: ConnectionModel; onClose: () => void }): React.ReactElement {
  const [draft, setDraft] = React.useState<Draft>(() => profile ? { ...profile, password: undefined } : model.preferences.createDraft());
  const [keepPassword, setKeepPassword] = React.useState(Boolean(profile?.hasPassword));
  const [showPassword, setShowPassword] = React.useState(false);
  const form = React.useRef<HTMLFormElement>(null);
  const field = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft(previous => ({ ...previous, [key]: value }));
    if (model.notice) { model.notice = null; model.changed.emit(); }
  };
  const payload = (): Draft => {
    const value = { ...draft, name: draft.name.trim(), host: draft.host.trim() };
    if (keepPassword && !draft.password) { delete value.password; }
    else { value.password = draft.password || ''; }
    return value;
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (await model.save(payload())) { onClose(); }
  };
  const busy = Boolean(model.busy);
  return <form className="ddb-form" onSubmit={event => void submit(event)} ref={form}>
    <Button minimal small className="ddb-back" type="button" disabled={busy} onClick={onClose}>← 返回连接列表</Button>
    <div className="ddb-form-title"><h2>{profile ? '编辑连接' : '新增连接'}</h2><p>配置 DolphinDB 服务器与登录信息。</p></div>
    <fieldset disabled={busy}>
      <label htmlFor="ddb-name">连接名称 <span>*</span></label>
      <InputGroup id="ddb-name" required maxLength={80} placeholder="例如：本地开发" autoFocus autoComplete="off" value={draft.name} onChange={e => field('name', e.target.value)} />
      <label htmlFor="ddb-host">服务器地址 <span>*</span></label>
      <InputGroup id="ddb-host" required maxLength={253} placeholder="127.0.0.1 或 db.example.com" autoComplete="off" spellCheck={false} value={draft.host} onChange={e => field('host', e.target.value)} />
      <div className="ddb-field-row">
        <div><label htmlFor="ddb-port">端口 <span>*</span></label><InputGroup id="ddb-port" type="number" min={1} max={65535} required value={Number.isNaN(draft.port) ? '' : draft.port} onChange={e => field('port', e.target.valueAsNumber)} /></div>
        <div><label htmlFor="ddb-timeout">超时（秒）</label><InputGroup id="ddb-timeout" type="number" min={1} max={60} required value={Number.isNaN(draft.timeout) ? '' : draft.timeout} onChange={e => field('timeout', e.target.valueAsNumber)} /></div>
      </div>
      <div className="ddb-form-divider" />
      <label htmlFor="ddb-username">用户名</label>
      <InputGroup id="ddb-username" maxLength={128} autoComplete="off" placeholder="留空以匿名连接" value={draft.username} onChange={e => field('username', e.target.value)} />
      <label htmlFor="ddb-password">密码</label>
      <div className="ddb-password-field"><InputGroup id="ddb-password" type={showPassword ? 'text' : 'password'} maxLength={4096} autoComplete="new-password" placeholder={keepPassword ? '已保存，留空保持不变' : '输入密码'} value={draft.password || ''} onChange={e => field('password', e.target.value)} /><Button minimal small className="ddb-password-toggle" type="button" aria-label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? '隐藏' : '显示'}</Button></div>
      {keepPassword && <Button minimal small className="ddb-clear-password" type="button" onClick={() => { setKeepPassword(false); field('password', ''); }}>清除已有密码</Button>}
      <Checkbox className="ddb-checkbox" checked={draft.rememberPassword} disabled={busy || (!model.state.credentialStorage && !draft.rememberPassword)} onChange={e => field('rememberPassword', (e.currentTarget as CheckboxElement).checked)}>记住密码</Checkbox>
      <p className="ddb-help">{draft.rememberPassword ? '密码保存在 Jupyter 服务器的系统凭据库。' : '密码仅用于本次 Jupyter 服务会话，重启后需重新输入。'}{!model.state.credentialStorage && ' 此环境未启用系统凭据库。'}</p>
      <Checkbox className="ddb-checkbox" checked={draft.ssl} disabled={busy} onChange={e => field('ssl', (e.currentTarget as CheckboxElement).checked)}>使用 SSL 加密连接</Checkbox>
      <p className="ddb-help">需要 DolphinDB 服务器开启 HTTPS / SSL。</p>
    </fieldset>
    <div className="ddb-form-actions"><Button type="button" disabled={busy} onClick={() => { if (form.current?.reportValidity()) { void model.test(payload()); } }}>{model.busy === 'test' ? '测试中…' : '测试连接'}</Button><Button type="submit" disabled={busy}>{model.busy === 'save' ? '保存中…' : '保存连接'}</Button></div>
  </form>;
}
