/**
 * CommandCenterView - presentational Command Center (POC G+).
 *
 * Props in, `onSessionOpen` out. It receives the rooms the Office model
 * already produced (see office/useOfficeRooms.ts and the container), lays each
 * one out with officeScene and draws it as SVG + CSS: a room where every
 * member has a workstation, an agent at it and the lights of its state.
 *
 * It keeps no state and runs no effects or timers: motion is CSS keyed on the
 * station state; hover and keyboard focus (:hover and :has(.cc-hit:focus-visible),
 * so a mouse click does not leave a station lit) are CSS, so the whole station
 * highlights together. Stations are rendered in the model's reading order, so
 * the tab order follows it; depth is z-index (`--cc-rank`). Its only action is
 * the caller's `onSessionOpen` (the select action the Tree, the Office and the
 * kanban already use).
 *
 * The one piece of local state is `tipDismissed` per station (useState only, no
 * effect, no listener, no timer): Esc on the focused station closes its tooltip;
 * entering or leaving it with the pointer, or moving focus away, shows it again.
 * A tooltip that is open only by hover cannot be closed with Esc, because the
 * key goes to the focused element and a hover-only station has no focus; closing
 * it would need a document listener, which this view does not add.
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import { displayModel } from '../../AgenticCoding/SessionAttentionRow';
import { getProviderDisplayName } from '../../../utils/modelUtils';
import type { OfficeRoomView } from '../office/officeModel';
import { StationArt, stationAnchors } from './stationArt';
import { RoomShell, bayCaptionAnchor } from './roomArt';
import { VIEW, toPercent, f1 } from './iso';
import { buildScenes, type RoomScene, type SceneOverflowMember, type SceneStation } from './officeScene';
import './CommandCenter.css';

export interface CommandCenterViewProps {
  rooms: OfficeRoomView[];
  onSessionOpen: (sessionId: string) => void;
}

export function CommandCenterView({ rooms, onSessionOpen }: CommandCenterViewProps) {
  const { t } = useTranslation('agent');
  const scenes = useMemo(() => buildScenes(rooms), [rooms]);
  const titleById = useMemo(() => {
    const titles = new Map<string, string>();
    for (const room of rooms) for (const member of room.members) titles.set(member.sessionId, member.title);
    return titles;
  }, [rooms]);
  const attention = rooms.flatMap((room) =>
    room.members
      .filter((member) => member.waitingUser !== null || member.principal === 'error')
      .map((member) => ({ room, member })),
  );

  if (rooms.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[var(--nim-border)] px-4 py-6 text-center" data-testid="cc-empty">
        <p className="m-0 text-sm text-[var(--nim-text)]">{t('agentTeam.emptyTeamsTitle')}</p>
        <p className="m-0 mt-1 text-xs text-[var(--nim-text-muted)]">{t('agentTeam.emptyTeamsHint')}</p>
      </div>
    );
  }

  return (
    <div className="cc-view flex flex-col gap-4" data-testid="cc-view">
      <section
        className={`cc-attention rounded-md border px-4 py-3 ${attention.length > 0 ? 'border-[var(--nim-warning)]' : 'border-[var(--nim-border)]'}`}
        data-testid="cc-attention"
      >
        <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-[var(--nim-text-muted)]">
          {t('agentTeam.office.attentionHeading', { total: attention.length })}
        </h3>
        {attention.length === 0 ? (
          <p className="m-0 mt-1 text-sm text-[var(--nim-text-muted)]" data-testid="cc-attention-none">
            {t('agentTeam.office.attentionNone')}
          </p>
        ) : (
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
            {attention.map(({ room, member }) => (
              <li key={member.sessionId}>
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 rounded border-none bg-transparent px-1 py-0.5 text-left text-sm text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                  data-testid={`cc-attention-${member.sessionId}`}
                  title={t('agentTeam.openSession', { title: member.title })}
                  onClick={() => onSessionOpen(member.sessionId)}
                >
                  <span className="font-medium">{member.title}</span>
                  {member.role && (
                    <span className="text-[var(--nim-text-faint)]" data-testid={`cc-needs-role-${member.sessionId}`}>
                      · {t(`agentTeam.roles.${member.role}`)}
                    </span>
                  )}
                  {rooms.length > 1 && <span className="text-[var(--nim-text-faint)]">· {room.title}</span>}
                  <span className="ml-auto shrink-0 text-xs text-[var(--nim-warning)]">
                    {member.waitingUser
                      ? member.waitingUser.map((kind) => t(`agentTeam.office.waiting.${kind}`)).join(', ')
                      : t('agentTeam.office.state.error')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {scenes.map((scene) => (
        <CommandRoom key={scene.rootId} scene={scene} titleById={titleById} onSessionOpen={onSessionOpen} />
      ))}

      <p className="m-0 text-[11px] text-[var(--nim-text-faint)]" data-testid="cc-scope-note">
        {t('agentTeam.commandCenter.scopeNote')}
      </p>
    </div>
  );
}

function CommandRoom({
  scene,
  titleById,
  onSessionOpen,
}: {
  scene: RoomScene;
  titleById: ReadonlyMap<string, string>;
  onSessionOpen: (sessionId: string) => void;
}) {
  const { t } = useTranslation('agent');
  const bayLabel = toPercent(bayCaptionAnchor());
  return (
    <section className="cc-roomcard rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-4" data-testid={`cc-room-${scene.rootId}`}>
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="m-0 truncate text-sm font-semibold text-[var(--nim-text)]" title={scene.title}>
          {scene.title}
        </h3>
        <span className="text-[11px] text-[var(--nim-text-muted)]" data-testid="cc-room-summary">
          {[
            t('agentTeam.office.summary.working', { count: scene.workingCount }),
            t('agentTeam.office.summary.waitingUser', { count: scene.waitingUserCount }),
            scene.errorCount > 0 ? t('agentTeam.office.summary.error', { count: scene.errorCount }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </header>
      <div
        className="cc-room"
        style={{ aspectRatio: `${VIEW.w} / ${VIEW.h}` }}
        role="group"
        aria-label={t('agentTeam.commandCenter.roomLabel', { title: scene.title })}
        data-testid={`cc-floor-${scene.rootId}`}
      >
        <RoomShell scene={scene} />
        {scene.hasBay && (
          <span className="cc-bay-label" style={bayLabel} data-testid="cc-bay-label">
            {t('agentTeam.commandCenter.bayLabel')}
          </span>
        )}
        {scene.stations.map((station) => (
          <CommandStation
            key={station.sessionId}
            station={station}
            creatorTitle={station.createdBySessionId ? titleById.get(station.createdBySessionId) : undefined}
            onSessionOpen={onSessionOpen}
          />
        ))}
      </div>
      {scene.overflow.length > 0 && (
        <div className="cc-overflow mt-3 flex flex-wrap items-center gap-2" data-testid="cc-overflow">
          <span className="text-[11px] text-[var(--nim-text-muted)]">
            {t('agentTeam.commandCenter.overflowHeading', { count: scene.overflow.length })}
          </span>
          {scene.overflow.map((member: SceneOverflowMember) => (
            <button
              key={member.sessionId}
              type="button"
              className={`cc-chip cc-state-${member.state} cursor-pointer rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-0.5 text-[11px] text-[var(--nim-text)]`}
              data-testid={`cc-overflow-${member.sessionId}`}
              data-state={member.state}
              onClick={() => onSessionOpen(member.sessionId)}
            >
              {member.title}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Enter and Space open the session once: the keydown is the activation and its
 * default (the synthetic click) is cancelled, so a key press never fires twice.
 * A held key repeats keydown: the repeats are swallowed (default prevented, no
 * call), so holding Enter opens the session exactly once.
 */
function openOnKey(event: React.KeyboardEvent<HTMLButtonElement>, sessionId: string, onSessionOpen: (sessionId: string) => void) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  if (event.repeat) return;
  onSessionOpen(sessionId);
}

function stateLabelKey(station: SceneStation): string {
  if (station.state === 'waiting') return 'agentTeam.office.waitingUser';
  return `agentTeam.office.state.${station.state}`;
}

function CommandStation({
  station,
  creatorTitle,
  onSessionOpen,
}: {
  station: SceneStation;
  creatorTitle?: string;
  onSessionOpen: (sessionId: string) => void;
}) {
  const { t } = useTranslation('agent');
  const [tipDismissed, setTipDismissed] = useState(false);
  const anchors = useMemo(() => stationAnchors(station), [station.orient, station.cx, station.cy, station.width]);
  const roleLabel = station.role ? t(`agentTeam.roles.${station.role}`) : null;
  const stateLabel = t(stateLabelKey(station));
  const waitingText = station.waitingKinds.map((kind) => t(`agentTeam.office.waiting.${kind}`)).join(', ');
  const tipId = `cc-tip-${station.sessionId}`;
  const label = toPercent(anchors.label);
  const callout = toPercent(anchors.callout);
  const hullX = anchors.hull.map((p) => p[0]);
  const hullY = anchors.hull.map((p) => p[1]);
  const bx = Math.min(...hullX);
  const by = Math.min(...hullY);
  const bw = Math.max(...hullX) - bx;
  const bh = Math.max(...hullY) - by;
  const hit = {
    left: `${f1((bx / VIEW.w) * 1000) / 10}%`,
    top: `${f1((by / VIEW.h) * 1000) / 10}%`,
    width: `${f1((bw / VIEW.w) * 1000) / 10}%`,
    height: `${f1((bh / VIEW.h) * 1000) / 10}%`,
    clipPath: `polygon(${anchors.hull.map((p) => `${f1(((p[0] - bx) / bw) * 1000) / 10}% ${f1(((p[1] - by) / bh) * 1000) / 10}%`).join(',')})`,
  };
  const tipBelow = anchors.label[1] / VIEW.h < 0.5;
  const tipEnd = anchors.label[0] / VIEW.w > 0.55;
  const modelLine = [getProviderDisplayName(station.provider), displayModel(station.model, station.provider), station.effortLevel].filter(Boolean).join(' · ');
  const showCallout = station.state === 'waiting' || station.state === 'error';
  const ariaName = [t('agentTeam.openSession', { title: station.title }), roleLabel, stateLabel, waitingText || null].filter(Boolean).join(' · ');
  return (
    <div
      className={`cc-station cc-state-${station.state} cc-role-${station.accent}${station.isActiveSession ? ' is-active' : ''}${station.stoppedOnYou ? ' is-stopped' : ''}${tipDismissed ? ' is-dismissed' : ''}`}
      onMouseEnter={() => setTipDismissed(false)}
      onMouseLeave={() => setTipDismissed(false)}
      style={{ ['--cc-rank' as string]: station.paintRank }}
      data-testid={`cc-station-${station.sessionId}`}
      data-state={station.state}
      data-principal={station.principal}
      data-role={station.role ?? undefined}
      data-zone={station.zone}
      data-slot={station.slot}
      data-waiting-user={station.waitingKinds.length > 0 ? station.waitingKinds.join(',') : undefined}
      data-active-session={station.isActiveSession ? 'true' : undefined}
    >
      <svg className="cc-art" viewBox={`0 0 ${VIEW.w} ${VIEW.h}`} aria-hidden focusable="false">
        <StationArt station={station} />
      </svg>

      <div className="cc-label" style={label} data-testid={`cc-label-${station.sessionId}`}>
        {roleLabel && <span className="role">{roleLabel}</span>}
        <span className="name">{station.title}</span>
        <span className="state">
          <i aria-hidden />
          {stateLabel}
        </span>
        {station.mission && (
          <span className="mission" data-testid={`cc-mission-${station.sessionId}`}>
            {station.mission}
          </span>
        )}
      </div>

      {showCallout && (
        <div className="cc-callout" style={callout} data-testid={`cc-callout-${station.sessionId}`} aria-hidden>
          <i />
          <span>
            <b>{station.state === 'error' ? t('agentTeam.office.state.error') : t('agentTeam.office.waitingUser')}</b>
            {station.state === 'waiting' && waitingText && <em>{waitingText}</em>}
            {station.state === 'error' && station.waitingKinds.length > 0 && <em>{t('agentTeam.office.waitingUser')}: {waitingText}</em>}
          </span>
        </div>
      )}

      <button
        type="button"
        className="cc-hit"
        style={hit}
        aria-label={ariaName}
        aria-describedby={tipId}
        aria-current={station.isActiveSession ? 'true' : undefined}
        data-testid={`cc-hit-${station.sessionId}`}
        onClick={() => onSessionOpen(station.sessionId)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setTipDismissed(true);
          else openOnKey(event, station.sessionId, onSessionOpen);
        }}
        onBlur={() => setTipDismissed(false)}
        onKeyUp={(event) => {
          // Space activates a button on keyup in some engines; the keydown already opened it.
          if (event.key === ' ') event.preventDefault();
        }}
      />

      <div
        id={tipId}
        role="tooltip"
        className={`cc-tip ${tipBelow ? 'is-below' : 'is-above'} ${tipEnd ? 'is-end' : 'is-start'}`}
        style={label}
        data-testid={`cc-tip-${station.sessionId}`}
      >
        <div className="head">
          <span className="name">{station.title}</span>
          {roleLabel && <span className="role">{roleLabel}</span>}
        </div>
        <div className="state">
          <i aria-hidden />
          <span>{station.stoppedOnYou ? t('agentTeam.office.state.workingStoppedOnYou') : stateLabel}</span>
        </div>
        {waitingText && (
          <div className="wait">
            {t('agentTeam.office.waitingUser')}: {waitingText}
          </div>
        )}
        {station.mission && (
          <>
            <div className="k">{t('agentTeam.commandCenter.missionLabel')}</div>
            <div className="mission">{station.mission}</div>
          </>
        )}
        <div className="meta">
          {modelLine && <div>{modelLine}</div>}
          {creatorTitle && <div>{t('agentTeam.office.createdBy', { title: creatorTitle })}</div>}
          {station.isActiveSession && <div>{t('agentTeam.office.activeSession')}</div>}
          <div className="id">
            {t('agentTeam.commandCenter.sessionLabel')}: {station.sessionId}
          </div>
        </div>
      </div>
    </div>
  );
}
