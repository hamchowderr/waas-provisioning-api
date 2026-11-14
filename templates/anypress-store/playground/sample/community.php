<?php
/**
 * FluentCommunity: forty members with bios, two space groups with four spaces (one private), a fortnight of posts
 * with a pinned welcome, comments and likes, and a course with three sections and nine lessons that members are
 * part-way through, with their questions on the lessons answered. Each member posts, comments and learns as themselves, through the community's own routes.
 */
$plan = $sample['community'];
$people = $sample['people'];
$admin = 1;
$as = static function (int $userId, callable $do) {
    $before = get_current_user_id();
    wp_set_current_user($userId);
    try {
        return $do();
    } finally {
        wp_set_current_user($before);
    }
};
$api = 'anypress_sample_api';

$members = [];
foreach ($plan['members'] as $who) {
    $id = anypress_sample_user(is_array($who) ? $sample['readers'][$who[1]] : $people[$who]);
    if ($id) {
        $user = \FluentCommunity\App\Models\User::find($id);
        if ($user) {
            $user->syncXProfile();
        }
        $members[] = $id;
    }
}

// Space groups and their spaces; everyone joins the public ones, eight join the private one.
$spaces = [];
foreach ($plan['groups'] as $g => [$groupTitle, $groupSpaces]) {
    [, $group] = $api('POST', '/fluent-community/v2/spaces/space_groups', ['title' => $groupTitle, 'slug' => sanitize_title($groupTitle), 'description' => '']);
    $groupId = (int) ($group['group']['id'] ?? $group['data']['id'] ?? 0);
    foreach ($groupSpaces as [$title, $about, $privacy]) {
        [, $made] = $api('POST', '/fluent-community/v2/spaces', ['space' => array_filter([
            'title' => $title, 'description' => $about, 'privacy' => $privacy, 'parent_id' => $groupId ?: null,
        ])]);
        $space = $made['space'] ?? null;
        if (!$space) {
            continue;
        }
        $spaces[] = $space;
        // Joined through the space's own model (the members screen's route does one person per request).
        $model = \FluentCommunity\App\Models\Space::find($space['id']);
        foreach ($model ? array_values($members) : [] as $n => $userId) {
            if ($privacy === 'public' || $n < 8) {
                $model->members()->syncWithoutDetaching([$userId => ['role' => 'member', 'status' => 'active']]);
            }
        }
    }
}

// The feed: each post by its author, a few days apart, with comments and likes from other members.
$memberIds = array_values($members);
foreach ($plan['feed'] as $n => [$author, $spaceIndex, $message, $pinned]) {
    $space = $spaces[$spaceIndex] ?? null;
    $authorId = $author ? ($memberIds[$author - 1] ?? $admin) : $admin;
    if (!$space) {
        continue;
    }
    [, $posted] = $as($authorId, static fn () => anypress_sample_api('POST', '/fluent-community/v2/feeds', [
        // An empty title: the community's request object keeps earlier routes' fields, and a post would take one.
        'title' => '', 'message' => $message, 'space' => $space['slug'], 'content_type' => 'text',
    ]));
    $feedId = (int) ($posted['feed']['id'] ?? 0);
    if (!$feedId) {
        continue;
    }
    $commenters = array_slice($memberIds, ($n % 5) + 1, $n % 3 + 1);
    foreach ($commenters as $c => $userId) {
        $as($userId, static fn () => anypress_sample_api('POST', "/fluent-community/v2/feeds/$feedId/comments", ['comment' => $plan['replies'][($n + $c) % count($plan['replies'])]]));
    }
    // Spread over two weeks, with likes; the community's own models keep the post's dates, pin and reactions.
    $feed = \FluentCommunity\App\Models\Feed::find($feedId);
    if ($feed) {
        foreach (array_slice($memberIds, $n % 4, 2 + $n % 5) as $userId) {
            \FluentCommunity\App\Models\Reaction::create(['user_id' => $userId, 'object_id' => $feedId, 'object_type' => 'feed', 'type' => 'like']);
            $feed->reactions_count = $feed->reactions_count + 1;
        }
        $when = anypress_sample_when((count($plan['feed']) - $n) * 1.2, 9 + $n % 10);
        $feed->created_at = $when;
        $feed->updated_at = $when;
        $feed->is_sticky = $pinned ? 1 : 0;
        $feed->save();
        // Its comments came over the next hours, and the activity feed says so.
        foreach (\FluentCommunity\App\Models\Comment::where('post_id', $feedId)->orderBy('id')->get() as $c => $comment) {
            $comment->created_at = $comment->updated_at = gmdate('Y-m-d H:i:s', strtotime($when) + (2 + $c * 3) * HOUR_IN_SECONDS);
            $comment->save();
        }
        foreach (\FluentCommunity\App\Models\Activity::where('feed_id', $feedId)->orderBy('id')->get() as $c => $activity) {
            $activity->created_at = $activity->updated_at = gmdate('Y-m-d H:i:s', strtotime($when) + ($c ? (2 + ($c - 1) * 3) * HOUR_IN_SECONDS : 0));
            $activity->save();
        }
    }
}

// The course: sections and lessons published, members enrolled and part-way through.
$course = $plan['course'];
[, $made] = $api('POST', '/fluent-community/v2/admin/courses', [
    'title' => $course['title'], 'description' => $course['description'], 'privacy' => 'public',
    'status' => 'published', 'course_type' => 'self_paced',
]);
$courseId = (int) ($made['course']['id'] ?? 0);
$lessons = [];
foreach ($courseId ? $course['sections'] : [] as [$sectionTitle, $sectionLessons]) {
    [, $section] = $api('POST', "/fluent-community/v2/admin/courses/$courseId/sections", ['title' => $sectionTitle]);
    $sectionId = (int) ($section['section']['id'] ?? 0);
    if ($sectionId) {
        $api('PUT', "/fluent-community/v2/admin/courses/$courseId/sections/$sectionId", ['section' => ['title' => $sectionTitle, 'status' => 'published']]);
    }
    foreach ($sectionLessons as [$title, $body]) {
        [, $lesson] = $api('POST', "/fluent-community/v2/admin/courses/$courseId/lessons", ['title' => $title, 'section_id' => $sectionId]);
        $lessonId = (int) ($lesson['lesson']['id'] ?? 0);
        if ($lessonId) {
            $api('PUT', "/fluent-community/v2/admin/courses/$courseId/lessons/$lessonId", ['lesson' => [
                'title' => $title, 'status' => 'published', 'parent_id' => $sectionId,
                'message' => "<p>$body</p><p>Take ten minutes to try this before the next lesson, and share what you did in Show your work.</p>",
                'meta' => ['enable_comments' => 'yes', 'enable_media' => 'yes'],
            ]]);
            $lessons[] = $lessonId;
        }
    }
}
foreach ($courseId ? $course['students'] : [] as [$member, $done]) {
    $userId = $memberIds[$member] ?? 0;
    if (!$userId) {
        continue;
    }
    $api('POST', "/fluent-community/v2/admin/courses/$courseId/students", ['user_id' => $userId]);
    foreach (array_slice($lessons, 0, $done) as $lessonId) {
        $as($userId, static fn () => anypress_sample_api('PUT', "/fluent-community/v2/courses/$courseId/lessons/$lessonId/completion", ['state' => 'completed']));
    }
}

// Questions on the lessons from students who reached them, each answered by the course lead a few hours later.
foreach ($courseId ? ($course['questions'] ?? []) : [] as $q => [$lesson, $member, $question, $answer]) {
    $lessonId = $lessons[$lesson] ?? 0;
    $userId = $memberIds[$member] ?? 0;
    if (!$lessonId || !$userId) {
        continue;
    }
    [, $asked] = $as($userId, static fn () => anypress_sample_api('POST', "/fluent-community/v2/feeds/$lessonId/comments", ['comment' => $question, 'parent_id' => 0]));
    $askedId = (int) ($asked['comment']['id'] ?? 0);
    if ($askedId) {
        $api('POST', "/fluent-community/v2/feeds/$lessonId/comments", ['comment' => $answer, 'parent_id' => $askedId]);
    }
    $when = strtotime(anypress_sample_when(40 - $q * 5.5, 19));
    foreach (\FluentCommunity\App\Models\Comment::where('post_id', $lessonId)->where(static fn ($w) => $w->where('id', $askedId)->orWhere('parent_id', $askedId))->orderBy('id')->get() as $c => $comment) {
        $comment->created_at = $comment->updated_at = gmdate('Y-m-d H:i:s', $when + $c * 4 * HOUR_IN_SECONDS);
        $comment->save();
    }
}

// Members joined over the last seven months and were last seen over the past few weeks, not all just now.
foreach ($memberIds as $k => $userId) {
    $profile = \FluentCommunity\App\Models\XProfile::where('user_id', $userId)->first();
    if ($profile) {
        $profile->created_at = anypress_sample_when(210 - $k * 5, 9 + $k % 9);
        $profile->last_activity = anypress_sample_when(($k * 7) % 26 + 0.3, 8 + $k % 12);
        $profile->save();
    }
    \FluentCommunity\App\Models\SpaceUserPivot::where('user_id', $userId)->update(['created_at' => anypress_sample_when(205 - $k * 5, 10)]);
}
