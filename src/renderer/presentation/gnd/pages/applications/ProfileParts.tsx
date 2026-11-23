import React, { useEffect, useId, useRef, useState } from 'react';
import {
  Check,
  FileText,
  Pencil,
  Plus,
  Search,
  Shuffle,
  Upload,
  X,
} from 'lucide-react';
import {
  AVATAR_MASCOTS,
  AVATAR_PHOTO_MAX,
  type Document,
  type DocumentCategory,
  type Experience,
} from '../../../../../shared/contracts';
import {
  importDocument,
  listDocuments,
  openDocument,
  replaceConfirmedSkills,
} from '../../../../api';
import { failureNotice, useNotify } from '../../../../app/Notifications';
import {
  Avatar,
  MASCOTS,
  mascotOf,
  photoDataUrl,
  randomMascot,
} from '../../components/Avatar';
import { Button } from '../../../components/Button';
import { Overlay } from '../../components/Overlay';
import {
  ExperienceEditor,
  removeExperience,
} from '../../../../pages/profile/editors';
import { knownSkill, suggestSkills } from './skillCatalogue';
import '../jobs/PreferencesPanel.css';
import './ProfileParts.css';

/* ---------- Profile picture ---------- */

/** The picture on the profile card; click it to change it. */
export function ProfilePicture({
  value,
  initials,
  onChange,
}: {
  value: string | null | undefined;
  initials: string;
  onChange: (next: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="gnd-avatar-button"
        aria-label="Change your picture"
        onClick={() => setOpen(true)}
      >
        <Avatar value={value} initials={initials} size={61} />
        <span className="gnd-avatar-edit" aria-hidden="true">
          <Pencil />
        </span>
      </button>
      {open && (
        <AvatarPicker
          value={value}
          onClose={() => setOpen(false)}
          onPick={async (next) => {
            await onChange(next);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

const MASCOT_NAMES: Record<string, string> = {
  sprout: 'Sprout',
  flop: 'Flop',
  wriggle: 'Wriggle',
  peek: 'Peek',
  nose: 'Nose',
  strut: 'Strut',
  twins: 'Twins',
  blob: 'Blob',
};

export function AvatarPicker({
  value,
  onPick,
  onClose,
}: {
  value: string | null | undefined;
  onPick: (next: string) => Promise<void>;
  onClose: () => void;
}) {
  const current = mascotOf(value);
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function choose(next: string) {
    setBusy(true);
    setError('');
    try {
      await onPick(next);
    } catch (e) {
      setError(failureNotice(e, 'Couldn’t save your picture.').message);
      setBusy(false);
    }
  }

  return (
    <Overlay
      title="Choose your picture"
      subtitle="Pick a sprout, or use a photo of your own."
      onClose={onClose}
    >
      <div className="gnd-mascot-grid" role="group" aria-label="Sprouts">
        {AVATAR_MASCOTS.map((name) => (
          <button
            key={name}
            type="button"
            className="gnd-mascot-option"
            aria-pressed={current === name}
            aria-label={MASCOT_NAMES[name]}
            disabled={busy}
            style={{ background: MASCOTS[name].tint }}
            onClick={() => void choose(`mascot:${name}`)}
          >
            <img src={MASCOTS[name].src} alt="" draggable={false} />
            {current === name && (
              <span className="gnd-mascot-tick" aria-hidden="true">
                <Check />
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="gnd-avatar-actions">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => file.current?.click()}
        >
          <Upload aria-hidden="true" /> Upload a photo
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            let next = randomMascot();
            while (next === value) next = randomMascot();
            void choose(next);
          }}
        >
          <Shuffle aria-hidden="true" /> Surprise me
        </Button>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const picked = e.target.files?.[0];
            e.target.value = '';
            if (!picked) return;
            void photoDataUrl(picked)
              .then((url) => {
                if (url.length > AVATAR_PHOTO_MAX) {
                  setError('That photo is too detailed. Try a smaller one.');
                  return;
                }
                return choose(url);
              })
              .catch(() =>
                setError('That file couldn’t be read. Try a PNG or JPEG.'),
              );
          }}
        />
      </div>
      {error && (
        <p className="gnd-form-error" role="alert">
          {error}
        </p>
      )}
    </Overlay>
  );
}

/* ---------- Skills ---------- */

/**
 * Confirmed skills as chips, and a search box that suggests skills as you
 * type, listed underneath. Pick one, or press Enter to add what you typed.
 */
export function SkillPicker({
  skills,
  onChange,
  autoOpen,
}: {
  skills: string[];
  onChange: (next: string[]) => void;
  autoOpen?: boolean;
}) {
  const notify = useNotify();
  const [adding, setAdding] = useState(!!autoOpen);
  const [typed, setTyped] = useState('');
  const [active, setActive] = useState(0);
  const [problem, setProblem] = useState('');
  const [focused, setFocused] = useState(false);
  const listId = useId();
  const options = suggestSkills(typed, skills);
  const showList = focused && typed.trim().length > 0 && options.length > 0;

  async function save(next: string[]) {
    try {
      onChange(await replaceConfirmedSkills(next));
    } catch (e) {
      setProblem(failureNotice(e, 'Couldn’t save your skills.').message);
    }
  }

  function add(value: string) {
    const skill = knownSkill(value) ?? value.replace(/\s+/gu, ' ').trim();
    if (!skill) return;
    if (skills.some((s) => s.toLowerCase() === skill.toLowerCase())) {
      setProblem(`${skill} is already in your skills.`);
      return;
    }
    setProblem('');
    setTyped('');
    setActive(0);
    void save([...skills, skill]);
  }

  return (
    <div className="gnd-skill-picker">
      <ul className="gnd-skill-chips" aria-label="Skills">
        {skills.map((skill) => (
          <li key={skill} className="gnd-skill-chip">
            {skill}
            <button
              type="button"
              aria-label={`Remove ${skill}`}
              onClick={() =>
                void save(skills.filter((s) => s !== skill)).catch((e) =>
                  notify(failureNotice(e, 'Couldn’t remove that skill.')),
                )
              }
            >
              <X aria-hidden="true" />
            </button>
          </li>
        ))}
        {!adding && (
          <li>
            <button
              type="button"
              className="gnd-skill-add"
              onClick={() => setAdding(true)}
            >
              <Plus aria-hidden="true" /> Add skills
            </button>
          </li>
        )}
      </ul>
      {adding && (
        <div className="gnd-skill-search">
          <Search aria-hidden="true" className="gnd-skill-search-icon" />
          <input
            className="gnd-input"
            role="combobox"
            aria-label="Search skills"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showList ? `${listId}-${active}` : undefined}
            placeholder="Search skills, e.g. Figma"
            value={typed}
            maxLength={120}
            autoFocus
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => {
              setTyped(e.target.value);
              setActive(0);
              setProblem('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && showList) {
                e.preventDefault();
                setActive((active + 1) % options.length);
              } else if (e.key === 'ArrowUp' && showList) {
                e.preventDefault();
                setActive((active - 1 + options.length) % options.length);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                add(showList ? options[active] : typed);
              } else if (e.key === 'Escape') {
                setTyped('');
                setAdding(false);
              }
            }}
          />
          <button
            type="button"
            className="gnd-skill-done"
            onClick={() => {
              setTyped('');
              setAdding(false);
              setProblem('');
            }}
          >
            Done
          </button>
          {showList && (
            <ul id={listId} className="gnd-pref-options" role="listbox">
              {options.map((option, index) => (
                <li
                  key={option}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className={index === active ? 'is-active' : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => add(option)}
                >
                  <Plus aria-hidden="true" />
                  <span>{option}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {problem && (
        <p className="gnd-form-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/* ---------- Experience ---------- */

const range = (item: Experience) => {
  const year = (value: string | null) => value?.slice(0, 4) ?? '';
  const start = year(item.startDate);
  const end = item.endDate ? year(item.endDate) : 'Present';
  return start ? `${start} – ${end}` : item.endDate ? end : '';
};

/** Current roles first, then the rest; add, edit and remove in a pop-up. */
export function ExperienceList({
  experiences,
  onChanged,
}: {
  experiences: Experience[];
  onChanged: () => void;
}) {
  const notify = useNotify();
  const [editing, setEditing] = useState<Experience | 'new' | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const work = experiences
    .filter((e) => e.category !== 'education')
    .sort(
      (a, b) =>
        Number(!!a.endDate) - Number(!!b.endDate) ||
        (b.startDate ?? '').localeCompare(a.startDate ?? ''),
    );

  return (
    <section className="gnd-experience" aria-labelledby="gnd-experience-title">
      <div className="gnd-applications-label-row">
        <h2 id="gnd-experience-title" className="gnd-applications-label">
          Experience
        </h2>
        <button
          type="button"
          className="gnd-link"
          onClick={() => setEditing('new')}
        >
          <Plus aria-hidden="true" /> Add experience
        </button>
      </div>
      {work.length ? (
        <ul className="gnd-experience-list">
          {work.map((item) => (
            <li key={item.id} className="gnd-experience-row">
              <div>
                <h3>
                  {item.roleTitle}
                  {!item.endDate && (
                    <span className="gnd-badge is-grey">Current</span>
                  )}
                </h3>
                <p className="gnd-muted">
                  {[item.organisation, range(item)].filter(Boolean).join(' · ')}
                </p>
              </div>
              <div className="gnd-experience-actions">
                {removing === item.id ? (
                  <>
                    <span className="gnd-muted">Remove?</span>
                    <button
                      type="button"
                      className="gnd-link"
                      onClick={() =>
                        void removeExperience(item)
                          .then(onChanged)
                          .catch((e) =>
                            notify(failureNotice(e, 'Couldn’t remove that.')),
                          )
                          .finally(() => setRemoving(null))
                      }
                    >
                      Yes
                    </button>
                    <button
                      type="button"
                      className="gnd-link is-quiet"
                      onClick={() => setRemoving(null)}
                    >
                      No
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="gnd-link"
                      onClick={() => setEditing(item)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="gnd-link is-quiet"
                      aria-label={`Remove ${item.roleTitle}`}
                      onClick={() => setRemoving(item.id)}
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="gnd-state">
          No experience yet. Add your current role so matches fit you better.
        </p>
      )}
      {editing && (
        <Overlay
          title={editing === 'new' ? 'Add experience' : 'Edit experience'}
          onClose={() => setEditing(null)}
        >
          <ExperienceEditor
            item={editing === 'new' ? undefined : editing}
            category="employment"
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              onChanged();
            }}
          />
        </Overlay>
      )}
    </section>
  );
}

/* ---------- Documents ---------- */

const DOC_TYPES: { value: DocumentCategory; label: string }[] = [
  { value: 'cv', label: 'CV' },
  { value: 'cover_letter', label: 'Cover letter' },
  { value: 'other', label: 'Other' },
];

/** Your documents, under the jobs applied count; add a CV, letter or other. */
export function DocumentsPanel() {
  const notify = useNotify();
  const [items, setItems] = useState<Document[] | null>(null);
  const [menu, setMenu] = useState(false);

  const load = () =>
    listDocuments()
      .then(setItems)
      .catch(() => setItems([]));
  useEffect(() => {
    void load();
  }, []);

  async function add(category: DocumentCategory) {
    setMenu(false);
    try {
      const result = await importDocument(category);
      if (!result.cancelled) await load();
    } catch (e) {
      notify(failureNotice(e, 'Couldn’t add that file.'));
    }
  }

  return (
    <section className="gnd-docs-panel" aria-labelledby="gnd-docs-title">
      <div className="gnd-docs-head">
        <h2 id="gnd-docs-title">Your documents</h2>
        <div className="gnd-docs-add">
          <button
            type="button"
            className="gnd-link"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Plus aria-hidden="true" /> Add
          </button>
          {menu && (
            <ul className="gnd-docs-menu" role="menu">
              {DOC_TYPES.map((type) => (
                <li key={type.value} role="none">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void add(type.value)}
                  >
                    {type.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {items === null ? (
        <p className="gnd-muted">Loading…</p>
      ) : items.length ? (
        <ul className="gnd-docs-list">
          {items.map((doc) => (
            <li key={doc.id}>
              <button
                type="button"
                className="gnd-docs-row"
                onClick={() =>
                  void openDocument(doc.id).catch((e) =>
                    notify(failureNotice(e, 'Couldn’t open that file.')),
                  )
                }
              >
                <FileText aria-hidden="true" />
                <span className="gnd-docs-name">{doc.originalName}</span>
                <span className="gnd-docs-type">
                  {DOC_TYPES.find((t) => t.value === doc.category)?.label}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="gnd-muted">
          No documents yet. Add your CV so you can attach it to applications.
        </p>
      )}
    </section>
  );
}
