import { BellRing, Clock3, History } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { Operator } from '@main/store/types';
import { useSession } from '@renderer/hooks/useSession';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';

type FollowUpPrompt = Awaited<
  ReturnType<typeof window.electron.followUp.getPending>
>;

const reasonText: Record<NonNullable<FollowUpPrompt>['reason'], string> = {
  launch: '欢迎回来',
  activate: '再次见到你',
  resume: '电脑已从休眠中恢复',
  unlock: '电脑已解锁',
  idle: '你已经停下来一会儿了',
};

export function FollowUpDialog() {
  const navigate = useNavigate();
  const { sessions, loading, setActiveSession } = useSession();
  const [prompt, setPrompt] = useState<FollowUpPrompt>(null);
  const [sessionsReady, setSessionsReady] = useState(false);

  useEffect(() => {
    if (!loading) setSessionsReady(true);
  }, [loading]);

  useEffect(() => {
    if (loading) return;
    void window.electron.followUp.getPending().then(setPrompt);
  }, [loading]);

  useEffect(() => window.electron.followUp.onPrompt(setPrompt), []);

  const previousSession = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0],
    [sessions],
  );

  useEffect(() => {
    if (sessionsReady && !loading && prompt && !previousSession) {
      void window.electron.followUp.complete(prompt.id);
      setPrompt(null);
    }
  }, [sessionsReady, loading, previousSession, prompt]);

  const close = useCallback(async () => {
    if (prompt) await window.electron.followUp.complete(prompt.id);
    setPrompt(null);
  }, [prompt]);

  const snooze = useCallback(async () => {
    if (prompt) await window.electron.followUp.snooze(prompt.id);
    setPrompt(null);
  }, [prompt]);

  const resume = useCallback(async () => {
    if (!prompt || !previousSession) return;
    await setActiveSession(previousSession.id);
    await window.electron.followUp.complete(prompt.id);
    setPrompt(null);

    const isRemote = previousSession.meta.operator !== Operator.LocalComputer;
    navigate(isRemote ? '/free-remote' : '/local', {
      state: {
        ...previousSession.meta,
        sessionId: previousSession.id,
        from: 'history',
      },
    });
  }, [navigate, previousSession, prompt, setActiveSession]);

  if (!prompt || loading || !previousSession) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && void close()}>
      <DialogContent className="max-h-[calc(100dvh-1.5rem)] overflow-x-hidden overflow-y-auto p-5 pr-12 sm:max-h-[calc(100vh-2rem)] sm:max-w-[560px] sm:p-6 sm:pr-12">
        <DialogHeader className="min-w-0 gap-3 text-left">
          <div className="mb-2 flex items-center gap-2 text-blue-600">
            <BellRing className="h-5 w-5" />
            <span className="text-sm font-medium">主动跟进</span>
          </div>
          {prompt.greeting && (
            <p className="max-h-[min(32vh,14rem)] overflow-y-auto whitespace-pre-wrap break-words pr-2 text-left text-sm leading-6 text-foreground [overflow-wrap:anywhere] sm:text-base">
              {prompt.greeting}
            </p>
          )}
          <DialogTitle className="text-left text-base leading-6 sm:text-lg">
            {reasonText[prompt.reason]}，
            {prompt.reason === 'idle'
              ? '建议继续推进最近的任务'
              : '要继续上次的任务吗？'}
          </DialogTitle>
          <DialogDescription className="text-left text-sm leading-6 break-words [overflow-wrap:anywhere]">
            {prompt.reason === 'idle'
              ? '检测到 10 秒没有操作。我可以帮你回到最近的工作，并从上次停下的位置继续。'
              : '我找到了最近一次对话，可以帮你从上次停下的位置继续。'}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 rounded-lg border bg-muted/40 p-4">
          <div className="flex min-w-0 items-start gap-3">
            <History className="mt-0.5 h-5 w-5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="break-words font-medium leading-5 [overflow-wrap:anywhere]">
                {previousSession.name}
              </p>
              <p className="mt-1 break-words text-sm leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                上次更新：{new Date(previousSession.updatedAt).toLocaleString()}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter className="flex-wrap gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={() => void close()}>
            暂不继续
          </Button>
          <Button
            variant="outline"
            className="whitespace-normal sm:whitespace-nowrap"
            onClick={() => void snooze()}
          >
            <Clock3 className="mr-2 h-4 w-4" />
            30 分钟后提醒
          </Button>
          <Button
            className="whitespace-normal sm:whitespace-nowrap"
            onClick={() => void resume()}
          >
            继续上次任务
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
