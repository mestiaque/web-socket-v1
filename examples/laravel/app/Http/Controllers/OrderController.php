<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Jobs\PublishDynamicSocketEvent;
use App\Models\Order;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/** Example: publish "order.created" only after the order is committed. */
final class OrderController
{
    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'product_id' => ['required', 'integer', 'exists:products,id'],
            'quantity' => ['required', 'integer', 'min:1'],
        ]);

        $order = DB::transaction(function () use ($request, $validated) {
            $order = Order::create([
                'user_id' => $request->user()->getAuthIdentifier(),
                'product_id' => $validated['product_id'],
                'quantity' => $validated['quantity'],
                'status' => 'pending',
            ]);

            // Queued with afterCommit(): nothing is sent if the transaction rolls back.
            PublishDynamicSocketEvent::dispatch(
                'order.created',
                ['orders', "user.{$order->user_id}"],
                [],
                ['order_id' => $order->id, 'status' => $order->status],
                "order.{$order->id}.created",
            );

            return $order;
        });

        return response()->json($order, 201);
    }
}
