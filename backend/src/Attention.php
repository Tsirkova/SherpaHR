<?php
declare(strict_types=1);

/**
 * Builds the manager's "needs attention" digest across active projects they lead.
 *
 * Signals are deterministic rules over task fields and free-text discussion, so a
 * manager can always see *why* a task is listed. Free-text detection is a keyword
 * heuristic: it finds explicit requests for help, not every possible problem.
 */
final class Attention
{
    public const DUE_SOON_HOURS = 48;
    public const STALE_DAYS = 3;

    /** Lower-case fragments that, in a teammate's comment, signal a problem or a request. */
    private const HELP_MARKERS = [
        'помог', 'помощь', 'нужно решение', 'нужен ответ', 'нужна ваша', 'нужно ваше',
        'не можем', 'не могу', 'не продолжить', 'не получается', 'нет ответа', 'ответа нет',
        'ждём', 'ждем', 'жду', 'ждут', 'застрял', 'блокир', 'препятстви', 'срочно', 'эскал', 'риск', 'руковод',
    ];

    /** Phrases that negate a marker, e.g. "препятствий нет". */
    private const CLEAR_MARKERS = ['препятствий нет', 'без препятствий', 'рисков нет', 'всё по плану', 'все по плану'];

    private const WEIGHTS = [
        'overdue' => 40, 'blocked' => 35, 'waiting_manager' => 30,
        'due_soon' => 15, 'unassigned' => 15, 'stale' => 10,
    ];

    public function __construct(private PDO $db, private int $userId) {}

    public function digest(DateTimeImmutable $now, bool $includeHidden): array
    {
        $projects = $this->all('SELECT p.id, p.name FROM projects p JOIN project_members m ON m.project_id=p.id AND m.user_id=p.owner_id WHERE p.owner_id=? AND p.archived=0 ORDER BY p.id', [$this->userId]);
        $manager = $this->all('SELECT name FROM users WHERE id=?', [$this->userId])[0]['name'] ?? '';
        $firstName = mb_strtolower(trim(explode('·', $manager)[0]));
        $users = array_column($this->all('SELECT id, name FROM users'), 'name', 'id');

        $items = [];
        $hidden = 0;
        $summary = [];
        foreach ($projects as $project) {
            $summary[$project['id']] = ['id' => (int) $project['id'], 'name' => $project['name'], 'items' => 0, 'critical' => 0];
            $tasks = $this->all("SELECT t.*, a.acked_version, a.acked_comment_id FROM tasks t LEFT JOIN attention_acks a ON a.task_id=t.id AND a.user_id=? WHERE t.project_id=? AND t.status <> 'done' ORDER BY t.id", [$this->userId, $project['id']]);
            foreach ($tasks as $task) {
                $comments = $this->all('SELECT c.id, c.user_id, c.body, c.created_at, u.name AS author FROM comments c JOIN users u ON u.id=c.user_id WHERE c.task_id=? ORDER BY c.id', [$task['id']]);
                $reasons = $this->reasons($task, $comments, $now, $firstName);
                if (!$reasons) {
                    continue;
                }
                $activity = $task['updated_at'];
                foreach ($comments as $comment) {
                    $activity = max($activity, $comment['created_at']);
                }
                // An acknowledgement hides the task until it is edited or discussed again.
                $lastId = $comments ? (int) end($comments)['id'] : 0;
                $acknowledged = $task['acked_version'] !== null
                    && (int) $task['acked_version'] === (int) $task['version'] && (int) $task['acked_comment_id'] === $lastId;
                if ($acknowledged) {
                    ++$hidden;
                    if (!$includeHidden) {
                        continue;
                    }
                }
                $score = 0;
                foreach ($reasons as $reason) {
                    $score += self::WEIGHTS[$reason['code']];
                }
                // Quote the unanswered request if there is one, otherwise the latest message.
                $requestId = array_column($reasons, 'comment_id')[0] ?? null;
                $quoted = $comments ? end($comments) : null;
                foreach ($comments as $comment) {
                    if ((int) $comment['id'] === $requestId) {
                        $quoted = $comment;
                    }
                }
                $items[] = [
                    'task' => [
                        'id' => (int) $task['id'], 'project_id' => (int) $task['project_id'], 'title' => $task['title'],
                        'status' => $task['status'], 'assignee_id' => $task['assignee_id'] === null ? null : (int) $task['assignee_id'],
                        'due_at' => $task['due_at'], 'updated_at' => $task['updated_at'], 'version' => (int) $task['version'],
                    ],
                    'project_name' => $project['name'],
                    'assignee_name' => $task['assignee_id'] === null ? null : ($users[$task['assignee_id']] ?? null),
                    'reasons' => $reasons,
                    'score' => $score,
                    'critical' => $this->isCritical($reasons),
                    'comment_count' => count($comments),
                    'quote' => $quoted ? [
                        'author' => $quoted['author'], 'body' => $quoted['body'], 'created_at' => $quoted['created_at'],
                        'is_request' => (int) $quoted['id'] === $requestId,
                    ] : null,
                    'activity_at' => $activity,
                    'acknowledged' => $acknowledged,
                ];
                if (!$acknowledged) {
                    ++$summary[$project['id']]['items'];
                    $summary[$project['id']]['critical'] += $this->isCritical($reasons) ? 1 : 0;
                }
            }
        }
        usort($items, fn(array $a, array $b) => [$a['acknowledged'], -$a['score'], $a['task']['due_at'] ?? '9999', $a['task']['id']]
            <=> [$b['acknowledged'], -$b['score'], $b['task']['due_at'] ?? '9999', $b['task']['id']]);

        return [
            'generated_at' => $now->format('Y-m-d\TH:i:s\Z'),
            'rules' => ['due_soon_hours' => self::DUE_SOON_HOURS, 'stale_days' => self::STALE_DAYS],
            'projects' => array_values($summary),
            'items' => $items,
            'hidden_count' => $hidden,
        ];
    }

    private function reasons(array $task, array $comments, DateTimeImmutable $now, string $firstName): array
    {
        $reasons = [];
        $nowStamp = $now->format('Y-m-d\TH:i:s\Z');
        if ($task['due_at'] !== null && $task['due_at'] < $nowStamp) {
            $days = (int) floor(($now->getTimestamp() - strtotime($task['due_at'])) / 86400);
            $reasons[] = $this->reason('overdue', $days > 0 ? 'Просрочена на ' . $this->days($days) : 'Срок истёк сегодня', 'critical');
        } elseif ($task['due_at'] !== null && strtotime($task['due_at']) - $now->getTimestamp() <= self::DUE_SOON_HOURS * 3600) {
            $reasons[] = $this->reason('due_soon', 'Срок в ближайшие ' . self::DUE_SOON_HOURS . ' ч', 'warning');
        }
        if ($task['status'] === 'blocked') {
            $reasons[] = $this->reason('blocked', 'Заблокирована', 'critical');
        }
        if ($task['assignee_id'] === null) {
            $reasons[] = $this->reason('unassigned', 'Нет исполнителя', 'warning');
        }
        // A teammate asked for help and the manager has not answered since.
        $request = null;
        foreach ($comments as $comment) {
            if ((int) $comment['user_id'] === $this->userId) {
                $request = null;
            } elseif ($this->asksForHelp($comment['body'], $firstName)) {
                $request = $comment;
            }
        }
        if ($request) {
            $reasons[] = $this->reason('waiting_manager', 'Ждёт вашего ответа: ' . $request['author'], 'critical', (int) $request['id']);
        }
        $activity = $task['updated_at'];
        foreach ($comments as $comment) {
            $activity = max($activity, $comment['created_at']);
        }
        $idle = (int) floor(($now->getTimestamp() - strtotime($activity)) / 86400);
        if (in_array($task['status'], ['in_progress', 'blocked'], true) && $idle >= self::STALE_DAYS) {
            $reasons[] = $this->reason('stale', 'Нет движения ' . $this->days($idle), 'info');
        }
        return $reasons;
    }

    private function asksForHelp(string $body, string $firstName): bool
    {
        $text = mb_strtolower($body);
        foreach (self::CLEAR_MARKERS as $marker) {
            $text = str_replace($marker, '', $text);
        }
        if ($firstName !== '' && preg_match('/(^|[^\p{L}])' . preg_quote($firstName, '/') . '([^\p{L}]|$)/u', $text)) {
            return true;
        }
        foreach (self::HELP_MARKERS as $marker) {
            if (str_contains($text, $marker)) {
                return true;
            }
        }
        return false;
    }

    private function reason(string $code, string $label, string $severity, ?int $commentId = null): array
    {
        return ['code' => $code, 'label' => $label, 'severity' => $severity] + ($commentId ? ['comment_id' => $commentId] : []);
    }

    private function isCritical(array $reasons): bool
    {
        return in_array('critical', array_column($reasons, 'severity'), true);
    }

    private function days(int $days): string
    {
        $mod10 = $days % 10;
        $mod100 = $days % 100;
        $word = $mod10 === 1 && $mod100 !== 11 ? 'день' : ($mod10 >= 2 && $mod10 <= 4 && ($mod100 < 12 || $mod100 > 14) ? 'дня' : 'дней');
        return $days . ' ' . $word;
    }

    private function all(string $sql, array $params = []): array
    {
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll();
    }
}
