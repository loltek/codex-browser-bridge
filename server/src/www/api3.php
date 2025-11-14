<?php

declare(strict_types=1);
error_reporting(E_ALL);
ini_set('display_errors', '1');
set_error_handler(function ($severity, $message, $file, $line) {
    if (error_reporting() & $severity) {
        throw new \ErrorException($message, 0, $severity, $file, $line);
    }
});

const DB_PATH = __DIR__ . DIRECTORY_SEPARATOR . '..' . DIRECTORY_SEPARATOR . 'db.db3';
const API_BASE_URL = 'https://codex-browser-bridge.loltek.net/api3.php';
const MAX_DATA_SIZE = 20 * 1024 * 1024; // 20 MB seems generous enough
const COMMAND_TASKS = [
    'execute_javascript' => true,
    'mouse_click_position' => true,
    'take_screenshot' => true,
    'keyboard_input' => true,
    'click_on_element' => true,
];

function disconnect_client(): void
{
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
        ignore_user_abort(true);
    }
}

function getDB(): \PDO
{
    static $pdo;
    if ($pdo instanceof \PDO) {
        return $pdo;
    }
    $init = !file_exists(DB_PATH);
    $pdo = new \PDO('sqlite:' . DB_PATH, '', '', [
        \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
        \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
        \PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    $pdo->exec('PRAGMA synchronous = NORMAL;');
    $pdo->exec('PRAGMA journal_mode = TRUNCATE;');
    $pdo->exec('PRAGMA foreign_keys = ON;');
    if ($init) {
        ensureSchema($pdo);
    }
    return $pdo;
}
function ensureSchema(\PDO $db): void
{
    $db->exec('CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL UNIQUE,
        session_status TEXT NOT NULL DEFAULT "created",
        content BLOB NOT NULL DEFAULT "",
        message_count INTEGER NOT NULL DEFAULT 0,
        access_count INTEGER NOT NULL DEFAULT 0,
        bandwidth_used INTEGER NOT NULL DEFAULT 0,
        created_by_ip TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );');
}
function request_value(string $key): ?string
{
    if (array_key_exists($key, $_POST)) {
        return $_POST[$key];
    }
    if (array_key_exists($key, $_GET)) {
        return $_GET[$key];
    }
    return null;
}

function respond_json(array $payload, int $status = 200, bool $exit = true): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    try {
        echo json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    } catch (\JsonException $error) {
        http_response_code(500);
        echo '{"error":"Failed to encode response"}';
    }
    if ($exit) {
        exit;
    }
}

function respond_text(string $payload, int $status = 200, bool $exit = true): void
{
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    echo $payload;
    if ($exit) {
        exit;
    }
}

function is_command_task(?string $task): bool
{
    return $task !== null && array_key_exists($task, COMMAND_TASKS);
}

function create_session_key(): string
{
    do {
        $ret = base64_encode(random_bytes(14));
        $ret = rtrim(strtr($ret, ['+' => '', '/' => '']), '=');
    } while (strlen($ret) < 11);
    return substr($ret, 0, 11);
}

function build_session_instructions(string $session_key): string
{
    $encoded_key = rawurlencode($session_key);
    $poll_responses_url = API_BASE_URL . '?task=fetch_response&client=codex&session_key=' . $encoded_key;
    $command_base_url = API_BASE_URL . '?client=codex&session_key=' . $encoded_key;
    $last_response_path = '/tmp/' . $session_key . '-last-response';
    $command_examples = <<<CMDS
curl '{$command_base_url}&task=execute_javascript' -F script='window.location.href'
curl '{$command_base_url}&task=take_screenshot' -F format='png' -F quality='90'
curl '{$command_base_url}&task=mouse_click_position' -F pos_x='1920' -F pos_y='1080'
curl '{$command_base_url}&task=click_on_element' -F selector='button.buy-now' -F button='left'
curl '{$command_base_url}&task=click_on_element' -F selector_function='() => document.querySelector("button.buy-now")'
curl '{$command_base_url}&task=keyboard_input' -F text='Hello world'
CMDS;
    return <<<TXT
Your session key: $session_key

1. Send commands by choosing the action as the task parameter on $command_base_url:

$command_examples

The click_on_element command accepts any CSS selector that resolves to a visible element in the active tab; omit -F button to default to a left click. When CSS selectors aren't enough, provide -F selector_function='() => ...' to run custom JavaScript that returns the element—just make sure it resolves to exactly one element, otherwise the command fails. Stick to click_on_element or mouse_click_position for real clicks—if you try to synthesize clicks with execute_javascript they run untrusted and may fail.

For multi-line selector functions, save the code to /tmp/<session-key>-selector.js and send it with `-F selector_function=@/tmp/<session-key>-selector.js` or use a single quoted heredoc (<<'EOF' ... EOF) so curl doesn't treat spaces, quotes, or braces as new fields.

2. After every command, poll $poll_responses_url once per second until you receive either "status":"response" (the command result) or "status":"response_empty". The command responses above only acknowledge that work was queued—the actual screenshot/image/text data is returned by fetch_response. Always capture each poll locally, e.g. `curl '$poll_responses_url' > {$last_response_path} && cat {$last_response_path}`, and confirm the HTTP status is 200 (use `file {$last_response_path}` for images) before consuming it.

The browser extension also polls every second for commands, so new instructions should reach the tab quickly.
TXT;
}

function handleSessionInstructions(bool $asPlainText = false): void
{
    $session_key = request_value('session_key');
    if ($session_key === null || trim($session_key) === '') {
        respond_json(['error' => 'Missing session_key'], 400);
    }
    $db = getDB();
    $stmt = $db->prepare('SELECT session_key FROM sessions WHERE session_key = :session');
    $stmt->execute([':session' => $session_key]);
    $row = $stmt->fetch();
    if ($row === false) {
        respond_json(['error' => 'Invalid session_key'], 400);
    }
    $instructions = build_session_instructions($session_key);
    if ($asPlainText) {
        respond_text($instructions);
    }
    $encoded_key = rawurlencode($session_key);
    $command_base_url = API_BASE_URL . '?client=codex&session_key=' . $encoded_key;
    respond_json([
        'session_key' => $session_key,
        'command_base_url' => $command_base_url,
        'command_tasks' => array_keys(COMMAND_TASKS),
        'fetch_response_url' => API_BASE_URL . '?task=fetch_response&client=codex&session_key=' . $encoded_key,
        'recommended_poll_interval_seconds' => 1,
        'instructions' => $instructions,
    ]);
}
function handleCreateSession(): void
{
    $now = time();
    $session_key = create_session_key();
    $db = getDB();
    $stmt = $db->prepare("INSERT INTO sessions (session_key, created_by_ip, created_at, last_accessed_at, last_updated_at, session_status) VALUES (:session_key, :created_by_ip, :now, :now, :now, :session_status)");
    $stmt->execute([
        ':session_key' => $session_key,
        ':created_by_ip' => $_SERVER['REMOTE_ADDR'] ?? 'unknown',
        ':now' => $now,
        ':session_status' => 'created',
    ]);
    respond_json([
        'session_key' => $session_key,
        //'instructions' => build_session_instructions($session_key),
    ]);
}
function handleSendCommand(?string $commandTask = null): void
{
    $session_key = request_value('session_key');
    if ($session_key === null || trim($session_key) === '') {
        respond_json(['error' => 'Missing session_key'], 400);
    }
    $data = $_POST;
    unset($data['task'], $data['client'], $data['session_key']);
    foreach ($_FILES as $field => $info) {
        if (!is_array($info) || !array_key_exists('error', $info)) {
            continue;
        }
        if ($info['error'] !== UPLOAD_ERR_OK || !isset($info['tmp_name'])) {
            continue;
        }
        $content = file_get_contents($info['tmp_name']);
        if ($content === false) {
            continue;
        }
        $data[$field] = $content;
    }
    if ($commandTask !== null) {
        $data['command'] = $commandTask;
    }
    if (!array_key_exists('command', $data)) {
        respond_json(['error' => 'Missing command'], 400);
    }
    $commandPayload = $data;
    if (!array_key_exists('type', $commandPayload) && isset($commandPayload['command'])) {
        $commandPayload['type'] = $commandPayload['command'];
    }
    $json = json_encode($commandPayload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    $data_size = strlen($json);
    if ($data_size > MAX_DATA_SIZE) {
        respond_json(['error' => 'Command data too large', 'max_data_size' => MAX_DATA_SIZE, 'data_size' => $data_size], 400);
    }
    // here we could validate that command "mouse_click_position" has pos_x and pos_y, etc. but for simplicity we skip that.
    $db = getDB();
    $stmt = $db->prepare("UPDATE sessions SET
    session_status='command_sent_from_codex',
    message_count = message_count + 1,
    access_count = access_count + 1,
    last_accessed_at = unixepoch(),
    last_updated_at = unixepoch(),
    bandwidth_used = bandwidth_used + :data_size,
    content = :content
    WHERE session_key = :session_key");
    $stmt->execute([
        ':data_size' => $data_size,
        ':session_key' => $session_key,
        ':content' => $json,
    ]);
    $rowCount = $stmt->rowCount();
    if ($rowCount === 0) {
        respond_json(['error' => 'Invalid session_key'], 400);
    }
    respond_json(['status' => 'command_pending', 'data_size' => $data_size, 'recommended_poll_interval_seconds' => 1]);
}

function handleFetchCommand(): void
{
    // This endpoint is polled by the browser extension to fetch new commands.
    $session_key = request_value('session_key');
    if ($session_key === null || trim($session_key) === '') {
        respond_json(['error' => 'Missing session_key'], 400);
    }
    $db = getDB();
    $stmt = $db->prepare("SELECT session_status, content FROM sessions WHERE session_key = :session");
    $stmt->execute([':session' => $session_key]);
    $row = $stmt->fetch();
    if ($row === false) {
        respond_json(['error' => 'Invalid session_key'], 400);
    }
    $status = $row['session_status'];
    if ($status !== 'command_sent_from_codex') {
        respond_json(['status' => 'no_command'], exit: false);
        disconnect_client();
        $stmt = $db->prepare("UPDATE sessions SET
        last_accessed_at = unixepoch(),
        access_count = access_count + 1
        WHERE session_key = :session_key");
        $stmt->execute([
            ':session_key' => $session_key,
        ]);
        exit;
    }
    $content = $row['content'];
    $response = null;
    if ($content === '') {
        $response = ['status' => 'command_empty'];
    } else {
        $response = [
            'status' => 'command',
            'command_data' => json_decode($content, true, 512, JSON_THROW_ON_ERROR),
        ];
    }
    respond_json($response, exit: false);
    disconnect_client();
    $data_size = strlen($content);
    $stmt = $db->prepare("UPDATE sessions SET
    session_status='command_sent_to_browser',
    access_count = access_count + 1,
    last_accessed_at = unixepoch(),
    last_updated_at = unixepoch(),
    bandwidth_used = bandwidth_used + :data_size
    WHERE session_key = :session_key");
    $stmt->execute([
        ':data_size' => $data_size,
        ':session_key' => $session_key,
    ]);
    exit;
}
function handleSendResponse(): void
{
    $session_key = request_value('session_key');
    if ($session_key === null || trim($session_key) === '') {
        respond_json(['error' => 'Missing session_key'], 400);
    }
    $data = $_POST;
    unset($data['task'], $data['client'], $data['session_key']);

    $json = json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    $data_size = strlen($json);
    if ($data_size > MAX_DATA_SIZE) {
        respond_json(['error' => 'Response data too large', 'max_data_size' => MAX_DATA_SIZE, 'data_size' => $data_size], 400);
    }
    $db = getDB();
    // should we first validate that the status is 'command_sent_to_browser'?
    $stmt = $db->prepare("UPDATE sessions SET
    session_status='response_sent_from_browser',
    message_count = message_count + 1,
    access_count = access_count + 1,
    last_accessed_at = unixepoch(),
    last_updated_at = unixepoch(),
    bandwidth_used = bandwidth_used + :data_size,
    content = :content
    WHERE session_key = :session_key
    ");
    $stmt->execute([
        ':data_size' => $data_size,
        ':session_key' => $session_key,
        ':content' => $json,
    ]);
    $rowCount = $stmt->rowCount();
    if ($rowCount === 0) {
        respond_json(['error' => 'Invalid session_key'], 400);
    }
    respond_json(['status' => 'response_pending', 'data_size' => $data_size, 'recommended_poll_interval_seconds' => 1]);
}
function handleFetchResponse(): void
{
    $session_key = request_value('session_key');
    if ($session_key === null || trim($session_key) === '') {
        respond_json(['error' => 'Missing session_key'], 400);
    }
    $db = getDB();
    $stmt = $db->prepare("SELECT session_status, content FROM sessions WHERE session_key = :session");
    $stmt->execute([':session' => $session_key]);
    $row = $stmt->fetch();
    if ($row === false) {
        respond_json(['error' => 'Invalid session_key'], 400);
    }
    $status = $row['session_status'];
    if ($status !== 'response_sent_from_browser') {
        respond_json(['status' => 'no_response'], exit: false);
        disconnect_client();
        $stmt = $db->prepare("UPDATE sessions SET
        last_accessed_at = unixepoch(),
        access_count = access_count + 1
        WHERE session_key = :session_key");
        $stmt->execute([
            ':session_key' => $session_key,
        ]);
        exit;
    }
    $content = $row['content'];
    $response = null;
    if ($content === '') {
        $response = ['status' => 'response_empty'];
    } else {
        $response = [
            'status' => 'response',
            'response_data' => json_decode($content, true, 512, JSON_THROW_ON_ERROR),
        ];
    }
    respond_json($response, exit: false);
    disconnect_client();
    $data_size = strlen($content);
    $stmt = $db->prepare("UPDATE sessions SET
    session_status='response_sent_to_codex',
    last_accessed_at = unixepoch(),
    last_updated_at = unixepoch(),
    bandwidth_used = bandwidth_used + :data_size
    WHERE session_key = :session_key");
    $stmt->execute([
        ':data_size' => $data_size,
        ':session_key' => $session_key,
    ]);
    exit;
}

$task = request_value('task');
if ($task === null || trim($task) === '') {
    handleSessionInstructions(true);
} elseif (is_command_task($task)) {
    handleSendCommand($task);
} elseif ($task === 'session_instructions') {
    handleSessionInstructions();
} elseif ($task === 'create_session') {
    handleCreateSession();
} elseif ($task === 'fetch_command') {
    handleFetchCommand();
} elseif ($task === "send_response") {
    handleSendResponse();
} elseif ($task === 'fetch_response') {
    handleFetchResponse();
} else {
    respond_json(['error' => 'Unknown task'], 400);
}
