<?php

declare(strict_types=1);

namespace Waas\Provisioning;

use RuntimeException;

/** A webhook request whose signature or timestamp doesn't check out. */
final class WebhookVerificationException extends RuntimeException
{
}
