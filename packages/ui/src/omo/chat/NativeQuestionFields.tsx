import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import type { InteractionAnswer, NativeQuestion } from '../contracts';

export type QuestionAnswers = Extract<InteractionAnswer, { answers: object }>['answers'];

export function NativeQuestionFields({ questions, answers, onChange, disabled }: {
  readonly questions: readonly NativeQuestion[];
  readonly answers: QuestionAnswers;
  readonly onChange: (answers: QuestionAnswers) => void;
  readonly disabled: boolean;
}) {
  const { t } = useI18n();
  return <div className="space-y-4">{questions.map((question) => {
    const answer = answers[question.id] ?? { selected: [] };
    return <fieldset key={question.id} disabled={disabled} className="min-w-0 space-y-2" data-question-id={question.id}>
      <legend className="typography-ui-label font-medium">{question.header}</legend>
      <p className="whitespace-pre-wrap break-words typography-markdown">{question.question}</p>
      {question.multiSelect && <p className="typography-meta text-muted-foreground">{t('chat.questionCard.selectMultiple')}</p>}
      <div className="flex flex-col items-start gap-2">{question.options.map((option) => {
        const selected = answer.selected.includes(option.label);
        return <div key={option.label} className="w-full space-y-1">
          <Button variant="chip" size="sm" disabled={disabled} aria-pressed={selected}
            className="max-w-full whitespace-normal text-left" data-question-option={option.label}
            onClick={() => {
              const next = selected ? answer.selected.filter((value) => value !== option.label)
                : question.multiSelect ? [...answer.selected, option.label] : [option.label];
              onChange({ ...answers, [question.id]: { selected: next, text: question.multiSelect ? answer.text : undefined } });
            }}>{option.label}</Button>
          <p className="break-words typography-meta text-muted-foreground">{option.description}</p>
        </div>;
      })}</div>
      <label className="block space-y-1">
        <span className="typography-meta text-muted-foreground">{t('chat.questionCard.yourAnswer')}</span>
        <Input data-question-text={question.id} disabled={disabled} value={answer.text ?? ''}
          onChange={(event) => onChange({ ...answers, [question.id]: {
            selected: question.multiSelect ? answer.selected : [], text: event.currentTarget.value,
          } })} />
      </label>
    </fieldset>;
  })}</div>;
}

export function NativeQuestionComment({ value, onChange, disabled }: {
  readonly value: string; readonly onChange: (value: string) => void; readonly disabled: boolean;
}) {
  const { t } = useI18n();
  return <label className="block space-y-1">
    <span className="typography-meta text-muted-foreground">{t('omo.dialogs.comment')}</span>
    <Textarea rows={2} disabled={disabled} data-testid="omo-question-comment" value={value}
      onChange={(event) => onChange(event.currentTarget.value)} />
  </label>;
}
