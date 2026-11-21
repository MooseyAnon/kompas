import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Radar, RotateCw } from 'lucide-react';
import type {
  InsightsProgress,
  InsightsQuestion,
  InterviewMethod,
} from '../../../../shared/contracts';
import { getInsightsProgress, listInsightsQuestions } from '../../../api';
import { Button } from '../../../presentation/components/Button';
import { EmptyState } from '../../../presentation/components/EmptyState';
import { CompetencyProgress } from '../../../presentation/components/interviews/CompetencyProgress';
import { HistoryDetail } from '../history/HistoryDetail';
import './CompetenciesTab.css';

type Loaded = {
  progress: InsightsProgress;
  questions: InsightsQuestion[];
  nextCursor: string | null;
};
export function CompetenciesTab({
  onOpenSession,
}: {
  onOpenSession: (id: string) => void;
}) {
  const [subject, setSubject] = useState('');
  const [method, setMethod] = useState<InterviewMethod | ''>('');
  const [filter, setFilter] = useState<{
    subject?: string;
    method?: InterviewMethod;
  }>({});
  const [load, setLoad] = useState<
    { status: 'loading' | 'error' } | { status: 'ready'; data: Loaded }
  >({ status: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  const [moreError, setMoreError] = useState(false);
  const request = useRef(0);
  const loadingMore = useRef(false);
  const detailOpened = useRef(false);

  useLayoutEffect(() => {
    if (selected) document.getElementById('competencies-detail-back')?.focus();
    else if (detailOpened.current) {
      document.getElementById('competencies-subject')?.focus();
      detailOpened.current = false;
    }
  }, [selected]);

  function openDetail(id: string) {
    detailOpened.current = true;
    setSelected(id);
  }

  async function read() {
    const current = ++request.current;
    setMoreError(false);
    setLoad({ status: 'loading' });
    try {
      const progress = await getInsightsProgress(filter);
      const page =
        progress.subject && progress.method
          ? await listInsightsQuestions({
              subject: progress.subject,
              method: progress.method,
              limit: 20,
            })
          : { items: [], nextCursor: null };
      if (current === request.current)
        setLoad({
          status: 'ready',
          data: {
            progress,
            questions: page.items,
            nextCursor: page.nextCursor,
          },
        });
    } catch {
      if (current === request.current) setLoad({ status: 'error' });
    }
  }
  useEffect(() => {
    void read();
    return () => {
      request.current++;
    };
  }, [filter]);

  async function more() {
    if (loadingMore.current || load.status !== 'ready' || !load.data.nextCursor)
      return;
    loadingMore.current = true;
    const current = request.current;
    const { progress, nextCursor } = load.data;
    setMoreError(false);
    try {
      const page = await listInsightsQuestions({
        cursor: nextCursor,
        subject: progress.subject!,
        method: progress.method!,
        limit: 20,
      });
      if (current === request.current)
        setLoad((previous) =>
          previous.status === 'ready'
            ? {
                status: 'ready',
                data: {
                  ...previous.data,
                  questions: [...previous.data.questions, ...page.items],
                  nextCursor: page.nextCursor,
                },
              }
            : previous,
        );
    } catch {
      if (current === request.current) setMoreError(true);
    } finally {
      loadingMore.current = false;
    }
  }

  if (selected)
    return (
      <div className="competencies-tab" data-testid="competencies-detail-view">
        <Button
          id="competencies-detail-back"
          variant="ghost"
          onClick={() => setSelected(null)}
        >
          Back to competencies
        </Button>
        <HistoryDetail sessionId={selected} onOpenSession={onOpenSession} />
      </div>
    );
  return (
    <div className="competencies-tab" data-testid="interviews-competencies">
      <header className="competencies-heading">
        <div>
          <h2>Practice progress</h2>
          <p>Observed, provisional reviews — not a profile skill rating.</p>
        </div>
        <Button
          variant="ghost"
          leadingIcon={<RotateCw aria-hidden="true" />}
          onClick={() => void read()}
        >
          Refresh
        </Button>
      </header>
      <form
        className="competencies-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter({
            ...(subject.trim() ? { subject: subject.trim() } : {}),
            ...(method ? { method } : {}),
          });
        }}
      >
        <label>
          Subject{' '}
          <input
            id="competencies-subject"
            value={subject}
            maxLength={200}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Latest comparable practice"
          />
        </label>
        <label>
          Method{' '}
          <select
            value={method}
            onChange={(event) =>
              setMethod(event.target.value as InterviewMethod | '')
            }
          >
            <option value="">Automatic cohort</option>
            <option value="quick_fire">Quick-fire</option>
            <option value="deep_loop">Deep Loop</option>
          </select>
        </label>
        <Button type="submit" variant="secondary">
          Apply filters
        </Button>
      </form>
      {load.status === 'loading' && <p role="status">Loading progress…</p>}
      {load.status === 'error' && (
        <div role="alert">
          <p>Progress couldn’t be loaded.</p>
          <Button onClick={() => void read()}>Try again</Button>
        </div>
      )}
      {load.status === 'ready' && (
        <>
          {load.data.progress.sessions === 0 ? (
            <EmptyState
              icon={Radar}
              title="No sessions in this cohort"
              data-testid="interviews-competencies-empty"
            >
              <p>
                Complete some practice, or try a different subject and method.
              </p>
            </EmptyState>
          ) : (
            <>
              <CompetencyProgress
                progress={load.data.progress}
                onSelectSession={openDetail}
              />
              <section aria-label="Questions in this cohort">
                <h3>Questions in this cohort</h3>
                <p>
                  Decisions appear only when released. Follow-ups and
                  reassessments are shown but do not contribute to the average.
                </p>
                {load.data.questions.length === 0 ? (
                  <p>No questions saved for this cohort yet.</p>
                ) : (
                  <ul className="competencies-questions">
                    {load.data.questions.map((question) => (
                      <li key={question.id}>
                        <span>
                          {question.competency ?? 'Competency unspecified'} ·{' '}
                          {question.kind === 'follow_up'
                            ? 'Follow-up'
                            : question.reassessmentOfRoundId
                              ? 'Reassessment'
                              : 'Independent question'}{' '}
                          · {question.decision ?? 'Not released'}
                        </span>
                        <Button
                          variant="ghost"
                          onClick={() => openDetail(question.sessionId)}
                        >
                          View session
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {moreError && (
                  <p role="alert">More questions couldn’t be loaded.</p>
                )}
                {load.data.nextCursor && (
                  <Button variant="secondary" onClick={() => void more()}>
                    Load more questions
                  </Button>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
