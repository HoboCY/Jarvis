using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jarvis.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class TaskUserInput : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "TaskUserInputRequests",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    TaskId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ExecutionId = table.Column<Guid>(type: "TEXT", nullable: false),
                    DeviceId = table.Column<Guid>(type: "TEXT", nullable: false),
                    RequestId = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    RequestIdIsString = table.Column<bool>(type: "INTEGER", nullable: false),
                    ItemId = table.Column<string>(type: "TEXT", maxLength: 500, nullable: false),
                    ThreadId = table.Column<string>(type: "TEXT", maxLength: 500, nullable: false),
                    TurnId = table.Column<string>(type: "TEXT", maxLength: 500, nullable: false),
                    QuestionsJson = table.Column<string>(type: "TEXT", maxLength: 100000, nullable: false),
                    AnswersJson = table.Column<string>(type: "TEXT", maxLength: 100000, nullable: true),
                    Status = table.Column<int>(type: "INTEGER", nullable: false),
                    CreatedAtMs = table.Column<long>(type: "INTEGER", nullable: false),
                    AnsweredAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    ClearedAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    ExpiresAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    Version = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TaskUserInputRequests", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TaskUserInputRequests_Devices_DeviceId",
                        column: x => x.DeviceId,
                        principalTable: "Devices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TaskUserInputRequests_TaskExecutions_ExecutionId",
                        column: x => x.ExecutionId,
                        principalTable: "TaskExecutions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_TaskUserInputRequests_Tasks_TaskId",
                        column: x => x.TaskId,
                        principalTable: "Tasks",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_TaskUserInputRequests_DeviceId_ExecutionId_RequestIdIsString_RequestId",
                table: "TaskUserInputRequests",
                columns: new[] { "DeviceId", "ExecutionId", "RequestIdIsString", "RequestId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_TaskUserInputRequests_ExecutionId",
                table: "TaskUserInputRequests",
                column: "ExecutionId");

            migrationBuilder.CreateIndex(
                name: "IX_TaskUserInputRequests_TaskId_Status_CreatedAtMs",
                table: "TaskUserInputRequests",
                columns: new[] { "TaskId", "Status", "CreatedAtMs" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "TaskUserInputRequests");
        }
    }
}
