import {
  AudioLines,
  ClipboardCheck,
  Hourglass,
  Lightbulb,
  MessageCircleQuestion,
  RefreshCcw,
  Sparkles,
  Sprout,
  Leaf,
  type LucideIcon,
} from 'lucide-react';

/**
 * Known operational categories of interview work. Each maps to something the
 * backend actually reports (`progress.operation`, snapshot shape) or, for
 * transcription, to an Audio STT job. Nothing here describes hidden model
 * steps.
 */
export type WorkCategory =
  | 'first_question'
  | 'next_question'
  | 'follow_up'
  | 'background'
  | 'review'
  | 'final_checks'
  | 'coaching'
  | 'reassessment'
  | 'synthesis'
  | 'transcription';

export interface StatusDescriptor {
  /** Precise, announced primary status. */
  label: string;
  /** Decorative, timer-driven secondary copy; never announced. */
  phrases: readonly string[];
  icon: LucideIcon;
}

/**
 * Visual secondary copy for status bubbles. These phrases are decoration, not
 * model reasoning or progress claims; the primary label stays precise. Each
 * category has its own set so two nearby bubbles never repeat each other.
 */
export const statusCopy: Record<WorkCategory, StatusDescriptor> = {
  first_question: {
    label: 'Preparing your first question',
    phrases: [
      'Finding a good opening question…',
      'Putting the first challenge together…',
      'Almost ready to begin…',
    ],
    icon: Sprout,
  },
  next_question: {
    label: 'Preparing the next question',
    phrases: [
      'Growing your next challenge…',
      'A little more puzzle-making…',
      'Choosing something different this time…',
    ],
    icon: Leaf,
  },
  follow_up: {
    label: 'Preparing a follow-up question',
    phrases: [
      'Picking up a thread from your answer…',
      'Thinking of a good “and then?”…',
      'Lining up the next prompt…',
    ],
    icon: MessageCircleQuestion,
  },
  background: {
    label: 'Working in the background',
    phrases: [
      'You can keep answering…',
      'Nothing here will interrupt you…',
      'Tending to what comes next…',
    ],
    icon: Hourglass,
  },
  review: {
    label: 'Reviewing your answer',
    phrases: [
      'Digesting your great answer…',
      'Checking the finer points…',
      'Connecting your ideas…',
    ],
    icon: ClipboardCheck,
  },
  final_checks: {
    label: 'Checking your answers',
    phrases: [
      'Reading back through your answers…',
      'Looking over the whole set…',
      'Nearly there…',
    ],
    icon: ClipboardCheck,
  },
  coaching: {
    label: 'Preparing coaching',
    phrases: [
      'Gathering some friendly tips…',
      'Finding what to try next time…',
      'Planting a few ideas…',
    ],
    icon: Lightbulb,
  },
  reassessment: {
    label: 'Preparing a reassessment question',
    phrases: [
      'Setting up another go…',
      'Shaping a fresh angle…',
      'Getting a second chance ready…',
    ],
    icon: RefreshCcw,
  },
  synthesis: {
    label: 'Preparing your results',
    phrases: [
      'Gathering the highlights…',
      'Turning your answers into feedback…',
      'Adding the finishing touches…',
    ],
    icon: Sparkles,
  },
  transcription: {
    label: 'Transcribing your answer',
    phrases: [
      'Listening back…',
      'Turning your words into text…',
      'Checking the transcription…',
    ],
    icon: AudioLines,
  },
};

/** Kept for the 07.2 outlet; identical to `statusCopy.first_question`. */
export const firstQuestionPhrases = statusCopy.first_question.phrases;
