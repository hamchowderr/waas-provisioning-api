<?php

declare(strict_types=1);

namespace Waas\Provisioning;

/** Every write is asynchronous: poll the matching list call until statusCode leaves Pending. */
final class StatusCode
{
    public const PENDING = 0;
    public const DONE = 1;
    public const FAILED = 2;
    public const REMOVING = 3;
}
