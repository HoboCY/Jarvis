using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jarvis.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase1ReviewFixes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_OutboxMessages_PublishedAtMs_NextAttemptAtMs",
                table: "OutboxMessages");

            migrationBuilder.AddColumn<Guid>(
                name: "ClaimedBy",
                table: "OutboxMessages",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "ClaimedUntilMs",
                table: "OutboxMessages",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AlterColumn<long>(
                name: "ExpiresAtMs",
                table: "IdempotencyRecords",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L,
                oldClrType: typeof(long),
                oldType: "INTEGER",
                oldNullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_OutboxMessages_PublishedAtMs_NextAttemptAtMs_ClaimedUntilMs",
                table: "OutboxMessages",
                columns: new[] { "PublishedAtMs", "NextAttemptAtMs", "ClaimedUntilMs" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_OutboxMessages_PublishedAtMs_NextAttemptAtMs_ClaimedUntilMs",
                table: "OutboxMessages");

            migrationBuilder.DropColumn(
                name: "ClaimedBy",
                table: "OutboxMessages");

            migrationBuilder.DropColumn(
                name: "ClaimedUntilMs",
                table: "OutboxMessages");

            migrationBuilder.AlterColumn<long>(
                name: "ExpiresAtMs",
                table: "IdempotencyRecords",
                type: "INTEGER",
                nullable: true,
                oldClrType: typeof(long),
                oldType: "INTEGER");

            migrationBuilder.CreateIndex(
                name: "IX_OutboxMessages_PublishedAtMs_NextAttemptAtMs",
                table: "OutboxMessages",
                columns: new[] { "PublishedAtMs", "NextAttemptAtMs" });
        }
    }
}
