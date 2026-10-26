// Меш-чат цеха: полностью офлайн. Сообщения хранятся локально (IndexedDB)
// и распространяются через Bluetooth / QR / текст — тем же механизмом LIP-пакетов,
// что и задания и журналы. Промежуточные устройства ретранслируют чужие
// сообщения дальше по цепочке (mesh), пока не кончится ttl.

import React, { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Send, Radio, QrCode, Copy, Check, Share2, Inbox } from 'lucide-react';
import { db } from '../core/db';
import { ChatMessage, SyncPacket, UserRole, CHAT_TTL_START } from '../core/types';
import { useAuthStore } from '../core/store/authStore';
import { encodePacket, decodePacket } from '../transfer/packet';
import { applyPacket } from '../transfer/apply';
import { ingestChatPacket, getRelayableMessages, canRelay } from './mesh';
import { useBluetooth } from '../transfer/useBluetooth';
import { PacketQrView } from '../stages/_ui/PacketOutModal';

const ROLE_LABELS: Record<UserRole, string> = {
  [UserRole.WORKER]: 'Работник',
  [UserRole.MASTER]: 'Мастер',
  [UserRole.TECHNOLOGIST]: 'Технолог',
  [UserRole.CHIEF]: 'Начальник',
};

const ROLE_COLORS: Record<UserRole, string> = {
  [UserRole.WORKER]: 'bg-slate-600',
  [UserRole.MASTER]: 'bg-amber-600',
  [UserRole.TECHNOLOGIST]: 'bg-violet-600',
  [UserRole.CHIEF]: 'bg-emerald-600',
};

type OutMode = 'none' | 'qr' | 'text';

export function ChatModule() {
  const currentUser = useAuthStore((s) => s.currentUser);
  const [draft, setDraft] = useState('');
  const [outMode, setOutMode] = useState<OutMode>('none');
  const [outText, setOutText] = useState('');
  const [copied, setCopied] = useState(false);
  const [incoming, setIncoming] = useState('');
  const [notice, setNotice] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const bt = useBluetooth();

  const messages = useLiveQuery(
    () => db.chatMessages.orderBy('ts').toArray(),
    [],
    [] as ChatMessage[],
  );

  // Очередь на авто-ретрансляцию: чужие «живые» сообщения, принятые этим устройством
  const relayList = useMemo(() => messages.filter((m) => m.from !== currentUser?.id && canRelay(m)), [messages, currentUser]);

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  };

  const buildPacket = (text: string): SyncPacket => {
    const ts = Date.now();
    const msg: ChatMessage = {
      id: `${currentUser!.id}:${ts}`,
      from: currentUser!.id,
      fromName: currentUser!.fullName || currentUser!.login,
      role: currentUser!.role,
      text,
      ts,
      ttl: CHAT_TTL_START,
    };
    return { v: 1, type: 'chat', payload: msg, from: currentUser!.id, ts };
  };

  /** Отправить своё сообщение: сохраняем локально + показываем выбор транспорта */
  const sendOwn = async () => {
    const text = draft.trim();
    if (!text || !currentUser) return;
    const p = buildPacket(text);
    await db.chatMessages.put(p.payload as ChatMessage);
    setDraft('');
    setOutText(encodePacket(p));
    setOutMode('qr');
    scrollToBottom();
  };

  /** Принять входящий пакет (из BLE-автоприёма или вставленного текста) */
  const acceptPacket = async (raw: string) => {
    const p = decodePacket(raw);
    if (!p) {
      setNotice('Не распознано как пакет чата. Проверьте текст/QR целиком.');
      return;
    }
    if (p.type !== 'chat') {
      // это может быть другой пакет — применяем общим механизмом
      const res = await applyPacket(p);
      setNotice(res.message);
      return;
    }
    const { applied, relayPacket } = await ingestChatPacket(p);
    setNotice(applied ? 'Сообщение принято ✓' : 'Сообщение не принято');
    if (relayPacket) {
      // предлагаем авто-ретрансляцию дальше по mesh
      setOutText(encodePacket(relayPacket));
      setOutMode('qr');
    }
  };

  /** Раздать очередь ретрансляции сразу нескольким узлам одной раздачей нельзя —
   *  но можно отправить все живые сообщения разом: соберём их в один пакет? Нет —
   *  формат пакета = одно сообщение. Поэтому ретранслируем по одному. */
  const relayOne = async (m: ChatMessage) => {
    const p: SyncPacket = { v: 1, type: 'chat', payload: m, from: m.from, ts: m.ts };
    setOutText(encodePacket(p));
    setOutMode('qr');
  };

  const copyOut = async () => {
    try {
      await navigator.clipboard.writeText(outText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setNotice('Не удалось скопировать — выделите текст вручную.');
    }
  };

  const shareOut = async () => {
    if (!navigator.share) {
      setNotice('Системная отправка недоступна в этом браузере. Скопируйте текст.');
      return;
    }
    try {
      await navigator.share({ text: outText });
    } catch {
      /* пользователь отменил */
    }
  };

  const isMine = (m: ChatMessage) => m.from === currentUser?.id;

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] max-w-3xl mx-auto">
      {/* Заголовок + статус BLE */}
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-bold text-white flex items-center gap-2">
          💬 Меш-чат цеха
          <span className="text-xs font-normal text-slate-400">(офлайн: Bluetooth / QR / текст)</span>
        </h2>
        <button
          onClick={() => (bt.status === 'receiving' ? bt.stop() : bt.startReceiving())}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition ${
            bt.status === 'receiving'
              ? 'bg-red-600 text-white animate-pulse'
              : 'bg-blue-600 text-white hover:bg-blue-500'
          }`}
        >
          <Radio className="w-4 h-4" />
          {bt.status === 'receiving' ? 'Стоп приём' : '🔵 Слушать эфир'}
        </button>
      </div>

      {bt.logLines.length > 0 && (
        <div className="mb-2 text-xs bg-slate-800/60 rounded-lg p-2 max-h-20 overflow-y-auto space-y-0.5">
          {bt.logLines.slice(-6).map((l, i) => (
            <div key={i} className={l.level === 'err' ? 'text-red-400' : l.level === 'ok' ? 'text-emerald-400' : 'text-slate-400'}>
              [{l.time}] {l.msg}
            </div>
          ))}
        </div>
      )}

      {/* Лента сообщений */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-2 pr-1 py-2">
        {messages.length === 0 && (
          <div className="text-center text-slate-500 text-sm py-10">
            Пока пусто. Напишите первое сообщение и передайте его коллеге по Bluetooth или QR.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${isMine(m) ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] rounded-2xl px-3 py-2 ${
                isMine(m) ? 'bg-blue-700 text-white rounded-br-sm' : 'bg-slate-700 text-slate-100 rounded-bl-sm'
              }`}
            >
              <div className="flex items-center gap-2 mb-0.5">
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full text-white ${ROLE_COLORS[m.role ?? UserRole.WORKER]}`}>
                  {ROLE_LABELS[m.role ?? UserRole.WORKER]}
                </span>
                <span className="text-xs font-semibold">{isMine(m) ? 'Вы' : m.fromName}</span>
                <span className="text-[10px] opacity-60">{new Date(m.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <div className="text-sm whitespace-pre-wrap break-words">{m.text}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Очередь ретрансляции (mesh) */}
      {relayList.length > 0 && (
        <div className="mb-2 rounded-lg border border-amber-700/50 bg-amber-900/20 p-2">
          <div className="text-xs text-amber-300 mb-1 font-semibold">
            🔁 Могу раздать дальше ({relayList.length}) — я промежуточный узел mesh:
          </div>
          <div className="flex flex-wrap gap-1">
            {relayList.slice(-5).map((m) => (
              <button
                key={m.id}
                onClick={() => relayOne(m)}
                className="text-[11px] bg-amber-700/40 hover:bg-amber-700/70 text-amber-100 px-2 py-1 rounded"
                title={`${m.fromName}: ${m.text.slice(0, 40)}`}
              >
                {m.fromName.split(' ')[0]}: {m.text.slice(0, 18)}…
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Панель вывода (QR / текст) */}
      {outMode !== 'none' && (
        <div className="mb-2 rounded-xl border border-slate-600 bg-slate-800 p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold text-white flex items-center gap-2">
              <QrCode className="w-4 h-4" /> Передача сообщения
            </div>
            <button onClick={() => setOutMode('none')} className="text-slate-400 hover:text-white text-sm">✕ закрыть</button>
          </div>
          <div className="flex gap-2 mb-2">
            <button
              onClick={async () => {
                const p = decodePacket(outText);
                if (!p) return;
                const ok = await bt.send(p);
                if (ok) setNotice('Отдано по Bluetooth ✓');
              }}
              disabled={bt.status === 'sending'}
              className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-lg py-2 font-medium"
            >
              {bt.status === 'sending' ? 'Раздаю…' : '🔵 Bluetooth (раздать)'}
            </button>
            <button
              onClick={() => setOutMode(outMode === 'qr' ? 'text' : 'qr')}
              className="bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg px-3"
            >
              {outMode === 'qr' ? 'Текстом' : 'QR'}
            </button>
          </div>
          {outMode === 'qr' ? (
            <div className="flex justify-center bg-white rounded-lg p-2">
              <PacketQrView text={outText} />
            </div>
          ) : (
            <textarea
              readOnly
              value={outText}
              className="w-full h-24 text-[11px] font-mono bg-slate-900 text-slate-300 rounded-lg p-2"
            />
          )}
          <div className="flex gap-2 mt-2">
            <button onClick={copyOut} className="flex items-center gap-1 text-xs bg-slate-700 hover:bg-slate-600 text-white px-3 py-1.5 rounded-lg">
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} Копировать
            </button>
            <button onClick={shareOut} className="flex items-center gap-1 text-xs bg-slate-700 hover:bg-slate-600 text-white px-3 py-1.5 rounded-lg">
              <Share2 className="w-3.5 h-3.5" /> Отправить
            </button>
          </div>
        </div>
      )}

      {/* Приём текстом */}
      <div className="mb-2 flex gap-2">
        <input
          value={incoming}
          onChange={(e) => setIncoming(e.target.value)}
          placeholder="Вставьте текст пакета (LIP:…) или отсканируйте QR камерой…"
          className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500"
        />
        <button
          onClick={async () => {
            if (!incoming.trim()) return;
            await acceptPacket(incoming);
            setIncoming('');
          }}
          className="flex items-center gap-1 bg-slate-700 hover:bg-slate-600 text-white text-sm px-3 rounded-lg"
        >
          <Inbox className="w-4 h-4" /> Принять
        </button>
      </div>

      {notice && (
        <div className="mb-2 text-xs text-emerald-300 bg-emerald-900/30 rounded-lg px-3 py-1.5">{notice}</div>
      )}

      {/* Ввод нового сообщения */}
      <div className="flex gap-2 pb-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendOwn();
            }
          }}
          rows={2}
          placeholder="Сообщение цеху… (Enter — отправить)"
          className="flex-1 bg-slate-800 border border-slate-600 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 resize-none"
        />
        <button
          onClick={sendOwn}
          disabled={!draft.trim()}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-xl px-4 flex items-center gap-1.5 font-medium"
        >
          <Send className="w-4 h-4" /> Отправить
        </button>
      </div>
    </div>
  );
}
