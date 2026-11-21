import React from 'react';
import { ArrowRight } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { InsightsProgress } from '../../../../shared/contracts';
import { Button } from '../Button';
import { Card } from '../Card';

export function CompetencyProgress({
  progress,
  onSelectSession,
}: {
  progress: InsightsProgress;
  onSelectSession: (id: string) => void;
}) {
  return (
    <section
      className="competency-progress"
      aria-label="Observed progress"
      data-testid="competency-progress"
    >
      <p className="competency-cohort">
        {progress.subject
          ? `${progress.subject} · ${progress.method === 'quick_fire' ? 'Quick-fire' : 'Deep Loop'}`
          : 'No comparable scored cohort yet'}
      </p>
      <div className="competency-stats">
        <Card padding="compact">
          <strong>{progress.sessions}</strong>
          <span>Sessions in cohort</span>
        </Card>
        <Card padding="compact">
          <strong>{progress.scoredRounds}</strong>
          <span>Scored independent rounds</span>
        </Card>
        <Card padding="compact">
          <strong>
            {progress.averageScore === null
              ? '—'
              : `${Math.round(progress.averageScore)} / 100`}
          </strong>
          <span>Observed round average</span>
        </Card>
        <Card padding="compact">
          <strong>
            {progress.pass} / {progress.fail}
          </strong>
          <span>Met / below provisional bar</span>
        </Card>
      </div>
      <p>
        {progress.unscoredRounds} unscored · {progress.pendingRounds} pending ·{' '}
        {progress.reassessments} linked reassessments (excluded from average).
      </p>
      {progress.variedBars && (
        <p>
          These sessions used different provisional bars; compare scores with
          care.
        </p>
      )}
      {progress.limited && (
        <p>Only the most recent 100 sessions are included.</p>
      )}
      {progress.points.length ? (
        <Card padding="compact">
          <h3>Completed scored sessions</h3>
          <div
            className="competency-chart"
            role="img"
            aria-label="Observed scores for completed sessions; numeric values listed below"
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={progress.points}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="completedAt"
                  tickFormatter={(date: string) =>
                    new Date(date).toLocaleDateString()
                  }
                />
                <YAxis domain={[0, 100]} />
                <Tooltip
                  labelFormatter={(date) =>
                    new Date(String(date)).toLocaleString()
                  }
                  formatter={(score) => [
                    `${Math.round(Number(score))} / 100`,
                    'Observed score',
                  ]}
                />
                <Line
                  type="linear"
                  dataKey="score"
                  stroke="var(--accent-ink)"
                  strokeWidth={2}
                  dot
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <ol className="competency-points">
            {progress.points.map((point) => (
              <li key={point.sessionId}>
                <span>
                  {new Date(point.completedAt).toLocaleString()} ·{' '}
                  {Math.round(point.score)} / 100 · {point.scoredRoundCount}{' '}
                  scored rounds
                </span>
                <Button
                  variant="secondary"
                  trailingIcon={<ArrowRight size={16} aria-hidden="true" />}
                  onClick={() => onSelectSession(point.sessionId)}
                >
                  View session
                </Button>
              </li>
            ))}
          </ol>
        </Card>
      ) : (
        <p>
          No completed session has a scored independent round yet. No trend is
          available.
        </p>
      )}
    </section>
  );
}
