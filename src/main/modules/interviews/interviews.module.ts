import {
  INTERVIEWS_API_VERSION,
  INTERVIEWS_MODULE_ID,
  insightsSessionsInputSchema,
  insightsSessionsOutputSchema,
  insightsQuestionsInputSchema,
  insightsQuestionsOutputSchema,
  insightsDetailInputSchema,
  insightsDetailOutputSchema,
  insightsProgressInputSchema,
  insightsProgressOutputSchema,
  interviewAnswersAudioGetInputSchema,
  interviewAnswersAudioGetOutputSchema,
  interviewAnswersDraftClearInputSchema,
  interviewAnswersDraftClearOutputSchema,
  interviewAnswersDraftGetInputSchema,
  interviewAnswersDraftGetOutputSchema,
  interviewAnswersDraftSaveInputSchema,
  interviewAnswersDraftSaveOutputSchema,
  interviewAnswersSubmitInputSchema,
  interviewAnswersSubmitOutputSchema,
  interviewCoachingRunInputSchema,
  interviewCoachingRunOutputSchema,
  interviewDeletedOutputSchema,
  interviewQuestionsGenerateInputSchema,
  interviewQuestionsGenerateOutputSchema,
  interviewQuestionsPreviewClearInputSchema,
  interviewQuestionsPreviewClearOutputSchema,
  interviewQuestionsPreviewGetInputSchema,
  interviewQuestionsPreviewGetOutputSchema,
  interviewReassessmentGenerateInputSchema,
  interviewReassessmentGenerateOutputSchema,
  interviewReviewsGetInputSchema,
  interviewReviewsGetOutputSchema,
  interviewReviewsRunInputSchema,
  interviewReviewsRunOutputSchema,
  interviewSessionOutputSchema,
  interviewSessionsAdvanceInputSchema,
  interviewSessionsAdvanceOutputSchema,
  interviewSessionsCancelInputSchema,
  interviewSessionsCancelOutputSchema,
  interviewSessionsCreateInputSchema,
  interviewSessionsDeleteInputSchema,
  interviewSessionsFinishInputSchema,
  interviewSessionsFinishOutputSchema,
  interviewSessionsGetInputSchema,
  interviewSessionsListInputSchema,
  interviewSessionsListOutputSchema,
  interviewSessionsProgressInputSchema,
  interviewSessionsProgressOutputSchema,
  interviewSessionsStartInputSchema,
  interviewSessionsStartOutputSchema,
  interviewSessionsTranscriptInputSchema,
  interviewSessionsTranscriptOutputSchema,
  interviewSessionsUpdateInputSchema,
  interviewWorkflowAnswerInputSchema,
  interviewWorkflowContinueInputSchema,
  interviewWorkflowIdInputSchema,
  interviewWorkflowStateOutputSchema,
} from '../../../shared/contracts';
import { defineCommand, type ModuleManifest } from '../../ipc/dispatcher';
import type { InterviewQuestionService } from './interviews.question.service';
import type { InterviewReviewService } from './interviews.review.service';
import type { InterviewSessionService } from './interviews.session.service';
import type { InterviewVoiceService } from './interviews.voice.service';
import type { InterviewsService } from './interviews.service';
import type { InterviewInsightsService } from './interviews.insights.service';

type CommandMap = ModuleManifest['commands'];

/** Build the statically-registered `interviews` module manifest (API major v1). */
export function createInterviewsModule(
  service: InterviewsService,
  questions: InterviewQuestionService,
  reviews: InterviewReviewService,
  sessions: InterviewSessionService,
  voice: InterviewVoiceService,
  insights?: InterviewInsightsService,
): ModuleManifest {
  return {
    id: INTERVIEWS_MODULE_ID,
    apiMajor: INTERVIEWS_API_VERSION,
    commands: {
      ...(insights ? insightsCommands(insights) : {}),
      ...sessionCommands(service),
      ...questionCommands(questions),
      ...answerCommands(reviews, voice),
      ...reviewCommands(reviews),
      ...runnerCommands(sessions),
      ...workflowCommands(sessions),
    },
  };
}

function insightsCommands(insights: InterviewInsightsService): CommandMap {
  return {
    'insights.sessions.list': defineCommand({
      input: insightsSessionsInputSchema,
      output: insightsSessionsOutputSchema,
      handle: (input) => insights.sessions(input),
    }),
    'insights.questions.list': defineCommand({
      input: insightsQuestionsInputSchema,
      output: insightsQuestionsOutputSchema,
      handle: (input) => insights.questions(input),
    }),
    'insights.sessions.get': defineCommand({
      input: insightsDetailInputSchema,
      output: insightsDetailOutputSchema,
      handle: (input) => insights.detail(input.sessionId),
    }),
    'insights.progress.get': defineCommand({
      input: insightsProgressInputSchema,
      output: insightsProgressOutputSchema,
      handle: (input) => insights.progress(input.subject, input.method),
    }),
  };
}

function sessionCommands(service: InterviewsService): CommandMap {
  return {
    'sessions.list': defineCommand({
      input: interviewSessionsListInputSchema,
      output: interviewSessionsListOutputSchema,
      handle: () => ({ items: service.listSessions() }),
    }),
    'sessions.get': defineCommand({
      input: interviewSessionsGetInputSchema,
      output: interviewSessionOutputSchema,
      handle: (input) => ({ session: service.getSession(input.id) }),
    }),
    'sessions.create': defineCommand({
      input: interviewSessionsCreateInputSchema,
      output: interviewSessionOutputSchema,
      handle: (input) => ({ session: service.createSession(input) }),
    }),
    'sessions.update': defineCommand({
      input: interviewSessionsUpdateInputSchema,
      output: interviewSessionOutputSchema,
      handle: (input) => ({
        session: service.updateSession(input.id, input.patch),
      }),
    }),
    'sessions.delete': defineCommand({
      input: interviewSessionsDeleteInputSchema,
      output: interviewDeletedOutputSchema,
      handle: (input) => {
        service.deleteSession(input.id);
        return { deleted: true as const };
      },
    }),
  };
}

function questionCommands(questions: InterviewQuestionService): CommandMap {
  return {
    'questions.generate': defineCommand({
      input: interviewQuestionsGenerateInputSchema,
      output: interviewQuestionsGenerateOutputSchema,
      handle: (input) => questions.generate(input.sessionId),
    }),
    'questions.preview.get': defineCommand({
      input: interviewQuestionsPreviewGetInputSchema,
      output: interviewQuestionsPreviewGetOutputSchema,
      handle: (input) => questions.getPreview(input.sessionId),
    }),
    'questions.preview.clear': defineCommand({
      input: interviewQuestionsPreviewClearInputSchema,
      output: interviewQuestionsPreviewClearOutputSchema,
      handle: (input) => questions.clearPreview(input.sessionId),
    }),
  };
}

function answerCommands(
  reviews: InterviewReviewService,
  voice: InterviewVoiceService,
): CommandMap {
  return {
    'answers.submit': defineCommand({
      input: interviewAnswersSubmitInputSchema,
      output: interviewAnswersSubmitOutputSchema,
      handle: (input) => reviews.submitAnswer(input),
    }),
    'answers.draft.get': defineCommand({
      input: interviewAnswersDraftGetInputSchema,
      output: interviewAnswersDraftGetOutputSchema,
      handle: (input) => voice.getDraft(input.sessionId, input.questionId),
    }),
    'answers.draft.save': defineCommand({
      input: interviewAnswersDraftSaveInputSchema,
      output: interviewAnswersDraftSaveOutputSchema,
      handle: (input) => voice.saveDraft(input),
    }),
    'answers.draft.clear': defineCommand({
      input: interviewAnswersDraftClearInputSchema,
      output: interviewAnswersDraftClearOutputSchema,
      handle: (input) => voice.clearDraft(input.sessionId, input.questionId),
    }),
    'answers.audio.get': defineCommand({
      input: interviewAnswersAudioGetInputSchema,
      output: interviewAnswersAudioGetOutputSchema,
      handle: (input) => voice.getAudio(input.sessionId, input.questionId),
    }),
  };
}

function reviewCommands(reviews: InterviewReviewService): CommandMap {
  return {
    'reviews.run': defineCommand({
      input: interviewReviewsRunInputSchema,
      output: interviewReviewsRunOutputSchema,
      handle: (input) =>
        reviews.runGranular(input.sessionId, (signal) =>
          reviews.reviewRound(input.sessionId, input.roundId, signal),
        ),
    }),
    'reviews.get': defineCommand({
      input: interviewReviewsGetInputSchema,
      output: interviewReviewsGetOutputSchema,
      handle: (input) => reviews.getRoundReview(input.sessionId, input.roundId),
    }),
    'coaching.run': defineCommand({
      input: interviewCoachingRunInputSchema,
      output: interviewCoachingRunOutputSchema,
      handle: (input) =>
        reviews.runGranular(input.sessionId, (signal) =>
          reviews.generateCoaching(input.sessionId, input.roundId, signal),
        ),
    }),
    'reassessment.generate': defineCommand({
      input: interviewReassessmentGenerateInputSchema,
      output: interviewReassessmentGenerateOutputSchema,
      handle: (input) =>
        reviews.runGranular(input.sessionId, (signal) =>
          reviews.generateReassessment(
            input.sessionId,
            input.failedRoundId,
            signal,
          ),
        ),
    }),
  };
}

function runnerCommands(sessions: InterviewSessionService): CommandMap {
  return {
    'sessions.start': defineCommand({
      input: interviewSessionsStartInputSchema,
      output: interviewSessionsStartOutputSchema,
      handle: (input) => sessions.start(input.sessionId),
    }),
    'sessions.progress': defineCommand({
      input: interviewSessionsProgressInputSchema,
      output: interviewSessionsProgressOutputSchema,
      handle: (input) => sessions.progress(input.sessionId),
    }),
    'sessions.advance': defineCommand({
      input: interviewSessionsAdvanceInputSchema,
      output: interviewSessionsAdvanceOutputSchema,
      handle: (input) => sessions.advance(input.sessionId),
    }),
    'sessions.finish': defineCommand({
      input: interviewSessionsFinishInputSchema,
      output: interviewSessionsFinishOutputSchema,
      handle: (input) => sessions.finish(input),
    }),
    'sessions.cancelOperation': defineCommand({
      input: interviewSessionsCancelInputSchema,
      output: interviewSessionsCancelOutputSchema,
      handle: (input) => sessions.cancelOperation(input.sessionId),
    }),
    'sessions.transcript': defineCommand({
      input: interviewSessionsTranscriptInputSchema,
      output: interviewSessionsTranscriptOutputSchema,
      handle: (input) => sessions.transcript(input.sessionId),
    }),
  };
}

function workflowCommands(sessions: InterviewSessionService): CommandMap {
  return {
    'workflow.state.get': defineCommand({
      input: interviewWorkflowIdInputSchema,
      output: interviewWorkflowStateOutputSchema,
      handle: (input) => ({ state: sessions.getState(input.sessionId) }),
    }),
    'workflow.answer.submit': defineCommand({
      input: interviewWorkflowAnswerInputSchema,
      output: interviewWorkflowStateOutputSchema,
      handle: (input) => ({ state: sessions.submitWorkflowAnswer(input) }),
    }),
    'workflow.continue': defineCommand({
      input: interviewWorkflowContinueInputSchema,
      output: interviewWorkflowStateOutputSchema,
      handle: (input) => ({ state: sessions.continueWorkflow(input) }),
    }),
    'workflow.results.request': defineCommand({
      input: interviewWorkflowIdInputSchema,
      output: interviewWorkflowStateOutputSchema,
      handle: (input) => ({
        state: sessions.requestResults(input.sessionId),
      }),
    }),
    'workflow.pause': defineCommand({
      input: interviewWorkflowIdInputSchema,
      output: interviewWorkflowStateOutputSchema,
      handle: (input) => ({ state: sessions.pause(input.sessionId) }),
    }),
  };
}
